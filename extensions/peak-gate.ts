/**
 * DeepSeek peak-hour LLM gate.
 *
 * DeepSeek bills peak rates during 01:00-04:00 and 06:00-10:00 UTC, Monday
 * through Friday (the same schedule the catalog marks on `deepseek` models,
 * which is what the `↑`/`↓` indicator in the cost display reads). While a peak
 * window is active this extension refuses to start new model calls process
 * wide by engaging the process-global `agentPauseGate` — the same gate the TUI
 * `/pause` command drives. Every agent loop in the process polls that gate
 * before each model call and before each tool call, so:
 *
 *   - in-flight provider streams finish (they were already billed),
 *   - nothing new is dispatched while the window is open,
 *   - every loop parks instead of aborting, so queued messages deliver
 *     normally when the window closes.
 *
 * A few side channels stream outside any agent loop (`/btw` side turns, session
 * title generation, remote compaction). Those cannot be parked here and cannot
 * be vetoed from `before_provider_request` — that hook may only replace the
 * payload, and a thrown error is swallowed — so they are warned about rather
 * than blocked.
 *
 * The decision is a pure function of the wall clock and a static window table:
 * state = f(now), never f(elapsed timers), so suspend/resume, clock jumps and
 * timer jitter cannot drift it. A precise edge timer engages/releases at the
 * boundary; a slow heartbeat re-derives state in case the process slept
 * through the edge.
 *
 * Config:
 *   - `~/.omp/agent/peak-gate.json`  optional override, `{ "windows": [...] }`
 *     where each window is `{ "startMinute": 60, "endMinute": 240,
 *     "weekdays": [1,2,3,4,5] }` (minute-of-day and weekday in UTC; weekday 0
 *     is Sunday). `{ "windows": [], "enabled": false }` disables the gate.
 *   - `OMP_PEAK_GATE=off`            same as `enabled: false`.
 *   - `OMP_PEAK_GATE_WINDOWS='[…]'`  JSON array replacing the windows.
 *   - `OMP_PEAK_GATE_QUIET=1`        suppress the "a call slipped through" warning.
 *   - `OMP_PEAK_GATE_KEEPALIVE=0`    let a parked headless run exit instead of
 *                                    holding the process open until the window closes.
 *   - `OMP_PEAK_GATE_DEBUG=/path`    append decision lines to a log file.
 *
 * Manual control: `/peak-gate status|pause|resume|reload`. A manual override
 * lasts until the next window boundary.
 *
 * Shipped as the `omp-peak-gate` plugin (`package.json#omp.extensions`); the
 * extension-module id is `peak-gate`. Disable with
 * `disabledExtensions: [extension-module:peak-gate]`, `omp plugin disable`, or
 * `{ "enabled": false }` in the config file above.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const CONFIG_PATH = `${process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME}/.omp/agent`}/peak-gate.json`;
const HEARTBEAT_MS = 30_000;
const NOTIFY_COOLDOWN_MS = 60_000;
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** One recurring peak-pricing window, expressed in UTC minute-of-day. */
interface PeakWindow {
	/** Weekdays the window applies to; 0 = Sunday, as `Date#getUTCDay`. */
	weekdays: readonly number[];
	/** Inclusive start, minute of day (0-1439). */
	startMinute: number;
	/** Exclusive end, minute of day (1-1440); must exceed the start. */
	endMinute: number;
}

/** DeepSeek published peak pricing: Mon-Fri 01:00-04:00 and 06:00-10:00 UTC. */
const DEFAULT_WINDOWS: readonly PeakWindow[] = [
	{ weekdays: [1, 2, 3, 4, 5], startMinute: 60, endMinute: 240 },
	{ weekdays: [1, 2, 3, 4, 5], startMinute: 360, endMinute: 600 },
];

/** UTC weekday and minute-of-day for a Unix-ms timestamp, without allocating a `Date`. */
function utcParts(timestamp: number): { weekday: number; minute: number } {
	const day = Math.floor(timestamp / DAY_MS);
	return {
		// Unix epoch was a Thursday, so day 0 is weekday 4.
		weekday: (((day + 4) % 7) + 7) % 7,
		minute: Math.floor((timestamp - day * DAY_MS) / MINUTE_MS),
	};
}

/** True when the timestamp falls inside any window. */
function isPeak(windows: readonly PeakWindow[], timestamp: number): boolean {
	const { weekday, minute } = utcParts(timestamp);
	return windows.some(
		window => window.weekdays.includes(weekday) && minute >= window.startMinute && minute < window.endMinute,
	);
}

/** Next window edge strictly after the timestamp, by enumerating a full UTC week. */
function nextTransition(windows: readonly PeakWindow[], timestamp: number): number | undefined {
	const firstDay = Math.floor(timestamp / DAY_MS);
	const horizon = timestamp + 8 * DAY_MS;
	let next = Number.POSITIVE_INFINITY;
	for (let offset = 0; offset <= 8; offset++) {
		const day = firstDay + offset;
		const weekday = (((day + 4) % 7) + 7) % 7;
		for (const window of windows) {
			if (!window.weekdays.includes(weekday)) continue;
			for (const minute of [window.startMinute, window.endMinute]) {
				const candidate = day * DAY_MS + minute * MINUTE_MS;
				if (candidate <= timestamp || candidate > horizon || candidate >= next) continue;
				// Overlapping or touching windows can hide an edge; keep only real changes.
				if (isPeak(windows, candidate - 1) !== isPeak(windows, candidate)) next = candidate;
			}
		}
	}
	return next === Number.POSITIVE_INFINITY ? undefined : next;
}

/** `HH:MM` for a minute-of-day. */
function formatMinute(minute: number): string {
	const hours = Math.floor(minute / 60) % 24;
	return `${String(hours).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** Human-readable UTC timestamp, e.g. `2026-09-29 06:00 UTC`. */
function utcLabel(timestamp: number): string {
	return `${new Date(timestamp).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

/** Append a diagnostic line when `OMP_PEAK_GATE_DEBUG` names a log file. */
function debug(message: string): void {
	const path = process.env.OMP_PEAK_GATE_DEBUG;
	if (path === undefined) return;
	try {
		appendFileSync(path, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// A diagnostic log must never break the gate.
	}
}

/** Human-readable window list, e.g. `Mon-Fri 01:00-04:00, 06:00-10:00 UTC`. */
function describeWindows(windows: readonly PeakWindow[]): string {
	if (windows.length === 0) return "no windows";
	const groups: { label: string; ranges: string[] }[] = [];
	for (const window of windows) {
		const days = [...window.weekdays].sort((a, b) => a - b);
		const label = days.length === 7 ? "daily" : days.map(day => WEEKDAY_NAMES[day] ?? `#${day}`).join(",");
		const range = `${formatMinute(window.startMinute)}-${formatMinute(window.endMinute)}`;
		const group = groups.find(candidate => candidate.label === label);
		if (group) group.ranges.push(range);
		else groups.push({ label, ranges: [range] });
	}
	return groups.map(group => `${group.label} ${group.ranges.join(", ")}`).join(" · ") + " UTC";
}

/** Validate one parsed window entry; returns undefined for anything malformed. */
function parseWindow(value: unknown): PeakWindow | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const start = "startMinute" in value ? value.startMinute : undefined;
	const end = "endMinute" in value ? value.endMinute : undefined;
	const weekdays = "weekdays" in value ? value.weekdays : [0, 1, 2, 3, 4, 5, 6];
	if (typeof start !== "number" || typeof end !== "number") return undefined;
	if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined;
	// Windows are half-open [start, end) within one UTC day; a midnight-crossing
	// window is two entries. Rejecting start >= end keeps a typo from silently
	// meaning "never" or "always".
	if (start < 0 || start > 1439 || end < 1 || end > 1440 || start >= end) {
		console.error(`[peak-gate] ignoring window ${JSON.stringify(value)}: expected startMinute < endMinute within a UTC day`);
		return undefined;
	}
	if (!Array.isArray(weekdays)) return undefined;
	const days = weekdays.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6);
	if (days.length !== weekdays.length || days.length === 0) return undefined;
	return { weekdays: days, startMinute: start, endMinute: end };
}

/** Load the effective window table: config file, then explicit env override. */
function loadWindows(): { windows: readonly PeakWindow[]; enabled: boolean; source: string } {
	let windows = DEFAULT_WINDOWS;
	let enabled = process.env.OMP_PEAK_GATE !== "off";
	let source = "built-in DeepSeek schedule";

	const envWindows = process.env.OMP_PEAK_GATE_WINDOWS;
	if (envWindows !== undefined) {
		try {
			const parsed: unknown = JSON.parse(envWindows);
			if (Array.isArray(parsed)) {
				const entries: unknown[] = parsed;
				windows = entries.map(parseWindow).filter((w): w is PeakWindow => !!w);
				source = "OMP_PEAK_GATE_WINDOWS";
			}
		} catch (error) {
			console.error(`[peak-gate] ignoring malformed OMP_PEAK_GATE_WINDOWS: ${String(error)}`);
		}
	} else {
		try {
			const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
			if (typeof parsed === "object" && parsed !== null) {
				if ("enabled" in parsed && parsed.enabled === false) enabled = false;
				if ("windows" in parsed && Array.isArray(parsed.windows)) {
					const entries: unknown[] = parsed.windows;
					windows = entries.map(parseWindow).filter((w): w is PeakWindow => !!w);
					source = CONFIG_PATH;
				}
			}
		} catch {
			// No config file (or unreadable/invalid JSON): keep the built-in schedule.
		}
	}
	return { windows, enabled, source };
}

/**
 * Extension factory. `agentPauseGate` is a process-global singleton shared with
 * the TUI `/pause` command, main agents, in-process subagents, and advisors.
 */
export default function deepseekPeakGate(pi: ExtensionAPI) {
	let { windows, enabled, source } = loadWindows();
	const quiet = process.env.OMP_PEAK_GATE_QUIET === "1";
	/** True only while this extension is the one holding the gate. */
	let holding = false;
	/** Manual override applied until the next window boundary. */
	let manual: "pause" | "resume" | undefined;
	let context: ExtensionContext | undefined;
	let edgeTimer: Timer | undefined;
	let heartbeat: Timer | undefined;
	/**
	 * Referenced interval that holds the event loop open while the gate is
	 * engaged. `ctx.setInterval`/`ctx.setTimeout` are deliberately unref'd, so a
	 * headless run (`omp -p`) whose loop parks on the gate would exit with no
	 * output instead of waiting out the window. Cleared on release and shutdown.
	 */
	let keepalive: Timer | undefined;
	let lastNotifyAt = 0;

	/** Keep a parked headless process alive; release it with the gate. */
	const holdProcess = (engaged: boolean): void => {
		if (process.env.OMP_PEAK_GATE_KEEPALIVE === "0") return;
		if (engaged && keepalive === undefined) {
			keepalive = setInterval(() => {}, 15_000);
		} else if (!engaged && keepalive !== undefined) {
			clearInterval(keepalive);
			keepalive = undefined;
		}
	};

	const shouldPause = (now: number): boolean => {
		if (!enabled) return false;
		if (manual === "pause") return true;
		if (manual === "resume") return false;
		return isPeak(windows, now);
	};

	/** Reconcile the gate with the clock. Idempotent; safe to call at any time. */
	const apply = (now: number): void => {
		const want = shouldPause(now);
		const wasHolding = holding;
		if (want && !agentPauseGate.paused) {
			// pause() reports false when someone else (the user, /pause) holds it.
			holding = agentPauseGate.pause();
		} else if (!want && holding && agentPauseGate.paused) {
			agentPauseGate.resume();
			holding = false;
		} else if (!want) {
			holding = false;
		}
		holdProcess(holding);

		const next = nextTransition(windows, now);
		const until = next === undefined ? "" : ` until ${utcLabel(next)}`;
		context?.ui.setStatus("peak-gate", holding ? `⏸ peak-gate${until}` : undefined);
		debug(
			`apply: want=${want} holding=${holding} wasHolding=${wasHolding} gate=${agentPauseGate.paused} next=${next === undefined ? "none" : utcLabel(next)} windows=${describeWindows(windows)}`,
		);
		if (holding === wasHolding) return;
		if (holding) {
			const release = next === undefined ? "" : `; releases ${utcLabel(next)}`;
			context?.ui.notify(`DeepSeek peak window (${describeWindows(windows)}): LLM calls paused${release}`, "info");
		} else {
			context?.ui.notify("LLM calls resumed (outside the DeepSeek peak window)", "info");
		}
	};

	/** Arm the precise edge timer plus the heartbeat re-derivation. */
	const arm = (ctx: ExtensionContext): void => {
		context = ctx;
		if (edgeTimer) ctx.clearTimer(edgeTimer);
		if (heartbeat) ctx.clearTimer(heartbeat);
		const schedule = (): void => {
			const now = Date.now();
			const next = nextTransition(windows, now);
			if (next !== undefined) {
				// +50ms so the timer lands just inside the new period, never 1ms early.
				edgeTimer = ctx.setTimeout(() => {
					debug("edge timer fired");
					manual = undefined;
					apply(Date.now());
					schedule();
				}, Math.max(1, Math.min(next - now + 50, 7 * DAY_MS)));
				debug(`armed edge timer for ${utcLabel(next)} (${Math.round((next - now) / 1000)}s)`);
			}
		};
		schedule();
		heartbeat = ctx.setInterval(() => apply(Date.now()), HEARTBEAT_MS);
		debug(`arm: enabled=${enabled} windows=${describeWindows(windows)}`);
		apply(Date.now());
	};

	pi.on("session_start", (_event, ctx) => arm(ctx));
	pi.on("session_shutdown", () => holdProcess(false));

	// Advisory slip detector. The gate parks every agent loop before its model
	// call, so a request that reaches this hook while a window is open came from
	// a path the gate cannot park (`/btw`, title generation, remote compaction).
	// This hook cannot refuse it: returning a payload is the only lever, and a
	// thrown error is swallowed by the runner. Warn (throttled) so a billed call
	// during a pause is visible instead of silent — and never abort the session,
	// which would not stop the request it was reacting to.
	pi.on("before_provider_request", (_event, ctx) => {
		if (!enabled || quiet) return;
		const now = Date.now();
		if (!shouldPause(now) || now - lastNotifyAt <= NOTIFY_COOLDOWN_MS) return;
		lastNotifyAt = now;
		debug("slip: a non-parked provider request reached the wire during a window");
		ctx.ui.notify(
			`A provider request ran during the DeepSeek peak window (${describeWindows(windows)}); the gate covers agent-loop calls only`,
			"warning",
		);
	});

	pi.registerCommand("peak-gate", {
		description: "Show or override the DeepSeek peak-hour LLM gate",
		handler: async (args, ctx) => {
			const action = args.trim().split(/\s+/)[0] || "status";
			const now = Date.now();
			switch (action) {
				case "pause":
					manual = "pause";
					apply(now);
					break;
				case "resume":
					manual = "resume";
					apply(now);
					ctx.ui.notify("Peak gate released until the next window boundary", "info");
					break;
				case "reload": {
					const loaded = loadWindows();
					windows = loaded.windows;
					enabled = loaded.enabled;
					source = loaded.source;
					manual = undefined;
					arm(ctx);
					ctx.ui.notify(`Peak gate reloaded from ${source}: ${describeWindows(windows)}`, "info");
					break;
				}
				default: {
					const next = nextTransition(windows, now);
					ctx.ui.notify(
						[
							`peak gate: ${enabled ? "enabled" : "disabled (OMP_PEAK_GATE=off or config)"}`,
							`windows: ${describeWindows(windows)} (${source})`,
							`now: ${isPeak(windows, now) ? "PEAK - LLM calls paused" : "off-peak"}`,
							`gate: ${agentPauseGate.paused ? (holding ? "engaged by peak-gate" : "engaged elsewhere (/pause)") : "open"}`,
							`next boundary: ${next === undefined ? "none" : utcLabel(next)}`,
						].join("\n"),
						"info",
					);
					break;
				}
			}
		},
	});
}
