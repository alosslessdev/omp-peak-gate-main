/**
 * DeepSeek peak-hour LLM gate.
 *
 * DeepSeek bills peak rates during 01:00-04:00 and 06:00-10:00 UTC, Monday
 * through Friday (the same schedule the catalog marks on `deepseek` models,
 * which is what the `↑`/`↓` indicator in the cost display reads). While a peak
 * window is active and the session's current model is a **remote DeepSeek
 * model** this extension refuses to start new model calls by engaging the
 * process-global `agentPauseGate` — the same gate the TUI `/pause` command
 * drives. Every agent loop in the process polls that gate before each model
 * call and before each tool call, so:
 *
 *   - in-flight provider streams finish (they were already billed),
 *   - nothing new is dispatched while the window is open,
 *   - every loop parks instead of aborting, so queued messages deliver
 *     normally when the window closes.
 *
 * Scope: the gate engages only for models whose provider, provider type, id or
 * name contains "deepseek" **and** that are served off this machine. DeepSeek
 * checkpoints running locally (Ollama, llama.cpp, LM Studio, … — loopback
 * baseUrl or a known local provider id) are never gated: they are not billed
 * at DeepSeek's peak rates. Any other model (Claude, GPT, local models) is
 * never gated either. `manual === "pause"` (`/peak-gate pause`) still pauses
 * everything regardless of model.
 *
 * Fallback (opt-in): if the model IS gated and oh-my-pi has a fallback chain
 * configured for it (`retry.fallbackChains` in omp settings — the same chain
 * core walks on provider errors), the session switches to the next usable
 * model instead of parking, then switches back when the window closes. No
 * chain configured (or every candidate is itself a remote DeepSeek model) →
 * the gate parks calls as before. This is opt-in purely through omp's own
 * fallback configuration; the plugin adds no settings of its own.
 *
 * A few side channels stream outside any agent loop (`/btw` side turns, session
 * title generation, remote compaction). Those cannot be parked here and cannot
 * be vetoed from `before_provider_request` — that hook may only replace the
 * payload, and a thrown error is swallowed — so they are warned about rather
 * than blocked.
 *
 * The decision is a pure function of the wall clock, the session model and a
 * static window table: state = f(now, model), never f(elapsed timers), so
 * suspend/resume, clock jumps and timer jitter cannot drift it. A precise edge
 * timer engages/releases at the boundary; a slow heartbeat re-derives state in
 * case the process slept through the edge or the model changed.
 *
 * Resume coverage. The gate only wakes loops that are still parked. A run can
 * end while the gate holds it — a host/deadline abort, a `wait` that timed
 * out, or a process that died mid-park — and then nothing exists to wake when
 * the gate opens. For a main session the plugin therefore:
 *   - watches gate transitions itself instead of assuming its own hold is the
 *     only holder,
 *   - remembers that the run saw a pause, and on gate release injects one
 *     continuation prompt when the session is idle with no pending async work
 *     (a live loop that woke on its own makes this a no-op),
 *   - drains steer/follow-up messages queued while an idle session was paused,
 *   - interrupts an in-flight `wait` with an `aside` after a real hold, since a
 *     wait ignores the gate and would otherwise keep the turn blocked,
 *   - persists a per-session marker so a resumed session after a hard process
 *     loss still gets one continuation prompt (cleared on graceful shutdown),
 *   - distinguishes a deliberate user interrupt (never auto-resumed) from an
 *     abort/deadline that the gate caused.
 * Auto-resume is bounded per hold and can be disabled with
 * `OMP_PEAK_GATE_RESUME=0`.
 *
 * Windows are a static weekly UTC table. There is deliberately no holiday
 * calendar (for example the yearly, subjectively-set Chinese holiday dates):
 * every weekday in the configured table is subject to the gate.
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
 *   - `OMP_PEAK_GATE_RESUME=0`       disable auto-resume (prompt, wait interrupt,
 *                                    restart marker).
 *   - fallback: `retry.fallbackChains` in omp settings (see above) — opt-in.
 *
 * Manual control: `/peak-gate status|pause|resume|reload`. A manual override
 * lasts until the next window boundary.
 *
 * Shipped as the `omp-peak-gate` plugin (`package.json#omp.extensions`); the
 * extension-module id is `peak-gate`. Disable with
 * `disabledExtensions: [extension-module:peak-gate]`, `omp plugin disable`, or
 * `{ "enabled": false }` in the config file above.
 */
import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { agentPauseGate, type ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isUserInterruptAbort } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	findRetryFallbackCandidates,
	formatRetryFallbackSelector,
	getRetryFallbackChains,
	resolveRetryFallbackChainKey,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME}/.omp/agent`;
const CONFIG_PATH = `${AGENT_DIR}/peak-gate.json`;
const RESUME_MARKER_PATH = `${AGENT_DIR}/peak-gate-resume.json`;
const HEARTBEAT_MS = 30_000;
const NOTIFY_COOLDOWN_MS = 60_000;
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Let a woken loop prove it is running before injecting a continuation prompt. */
const RESUME_GRACE_MS = 400;
/** A gate hold shorter than this is a fallback switch or a transient blip, not a park. */
const WAIT_INTERRUPT_MIN_HOLD_MS = 5_000;
/** Give an in-flight `wait` a moment to settle on its own before interrupting it. */
const WAIT_INTERRUPT_DELAY_MS = 1_500;
/** Do not auto-continue the same session more than this many times per hold. */
const MAX_RESUMES_PER_HOLD = 2;
/** Ignore resume markers older than this; a stale prompt is worse than a stall. */
const RESUME_MARKER_TTL_MS = 24 * 60 * 60_000;
/** Prompt injected when the session settled while the gate was holding it. */
const RESUME_PROMPT =
	"The peak-gate pause that interrupted this session has ended. Continue the task from where it stopped; do not repeat completed work. Background jobs and queued messages are still available.";
/** Delivery that ends an in-flight `wait` so the loop returns to the model. */
const WAIT_RESUME_PROMPT =
	"The peak-gate pause is over. Resume the task now. If you were waiting on background work, do not block on it again: read proc:// for its status and continue with the next step.";

/**
 * Provider ids that execute on the local machine even when their baseUrl is
 * not loopback (custom endpoints, port-forwarded daemons). `ollama-cloud` is
 * deliberately absent — it is a remote service.
 */
const LOCAL_PROVIDERS: Readonly<Record<string, true>> = {
	ollama: true,
	"llama.cpp": true,
	llamacpp: true,
	"lm-studio": true,
	lmstudio: true,
	local: true,
	vllm: true,
	koboldcpp: true,
	localai: true,
};

/** One recurring peak-pricing window, expressed in UTC minute-of-day. */
interface PeakWindow {
	/** Weekdays the window applies to; 0 = Sunday, as `Date#getUTCDay`. */
	weekdays: readonly number[];
	/** Inclusive start, minute of day (0-1439). */
	startMinute: number;
	/** Exclusive end, minute of day (1-1440); must exceed the start. */
	endMinute: number;
}

/** A fallback candidate resolved from `retry.fallbackChains`. */
interface FallbackTarget {
	model: Model;
	/** Thinking level the chain entry requested (`provider/id:level`), if any. */
	thinkingLevel: ThinkingLevel | undefined;
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

/** `provider/model-id` label for notifications and status output. */
function modelLabel(model: Model | undefined): string {
	return model === undefined ? "no model" : `${model.provider}/${model.id}`;
}

/** True when the model's provider, discovery backend, id or name says "deepseek". */
function matchesDeepseek(model: Model): boolean {
	return `${model.provider} ${model.providerType ?? ""} ${model.id} ${model.name}`.toLowerCase().includes("deepseek");
}

/** True when a baseUrl points at this machine (localhost / 127.0.0.0/8 / ::1). */
function isLoopbackBaseUrl(baseUrl: string): boolean {
	try {
		let host = new URL(baseUrl).hostname.toLowerCase();
		if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
		return host === "localhost" || host === "::1" || host === "0.0.0.0" || host.startsWith("127.");
	} catch {
		// Custom providers can register odd baseUrls; fall back to a substring check.
		const lower = baseUrl.toLowerCase();
		return lower.includes("localhost") || lower.includes("127.0.0.1");
	}
}

/** True when the model executes on this machine (Ollama, llama.cpp, …). */
function isLocalModel(model: Model): boolean {
	if (isLoopbackBaseUrl(model.baseUrl)) return true;
	const provider = model.provider.toLowerCase();
	if (LOCAL_PROVIDERS[provider] === true) return true;
	return model.providerType !== undefined && LOCAL_PROVIDERS[model.providerType.toLowerCase()] === true;
}

/**
 * The only models the gate touches automatically: DeepSeek-named and billed
 * through a remote endpoint. A DeepSeek checkpoint served by Ollama or
 * llama.cpp on this machine is local → not gated.
 */
function isGatedModel(model: Model): boolean {
	return matchesDeepseek(model) && !isLocalModel(model);
}

/** Why a model is out of the gate's scope, for `/peak-gate status`. */
function gatedReason(model: Model): string {
	if (!matchesDeepseek(model)) return `no "deepseek" in provider/model name (${modelLabel(model)})`;
	return `served locally via ${model.provider} - not billed at DeepSeek peak rates`;
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

/** Auto-resume is on unless explicitly disabled at process start. */
const RESUME_ENABLED = process.env.OMP_PEAK_GATE_RESUME !== "0";

/** Durable hint that a main session had work in flight when the gate parked it. */
interface ResumeMarker {
	sessionId: string;
	at: number;
	cwd?: string;
}

function readResumeMarker(): ResumeMarker | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(RESUME_MARKER_PATH, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const sessionId = "sessionId" in parsed ? parsed.sessionId : undefined;
		const at = "at" in parsed ? parsed.at : undefined;
		if (typeof sessionId !== "string" || typeof at !== "number" || !Number.isFinite(at)) return undefined;
		if (Date.now() - at > RESUME_MARKER_TTL_MS) return undefined;
		const cwd = "cwd" in parsed && typeof parsed.cwd === "string" ? parsed.cwd : undefined;
		return { sessionId, at, cwd };
	} catch {
		return undefined;
	}
}

function writeResumeMarker(sessionId: string, cwd: string): void {
	if (!RESUME_ENABLED) return;
	try {
		const marker: ResumeMarker = { sessionId, cwd, at: Date.now() };
		writeFileSync(RESUME_MARKER_PATH, JSON.stringify(marker));
	} catch (error) {
		debug(`resume: could not write ${RESUME_MARKER_PATH}: ${String(error)}`);
	}
}

function clearResumeMarker(): void {
	try {
		unlinkSync(RESUME_MARKER_PATH);
	} catch {
		// No marker (or no permission): nothing to clear.
	}
}

/**
 * Process-wide ownership of the pause gate. Every session's extension binding
 * may want the gate closed, but only the binding that actually engaged it may
 * release it. A plain boolean leaks the pause forever when one of several
 * sessions (or an earlier binding of the same session) shuts down first.
 */
const gateWanters = new Set<symbol>();
let gateOwnedByPeakGate = false;
let gateMonitorAttached = false;

function attachGateMonitor(): void {
	if (gateMonitorAttached) return;
	gateMonitorAttached = true;
	agentPauseGate.onChange(paused => {
		// The user's `/pause` toggle releases the gate directly; drop ownership
		// so a later release cannot resume a pause that is no longer ours.
		if (!paused) gateOwnedByPeakGate = false;
	});
}

function syncPeakGate(): void {
	attachGateMonitor();
	if (gateWanters.size > 0) {
		if (!agentPauseGate.paused && agentPauseGate.pause()) gateOwnedByPeakGate = true;
	} else if (gateOwnedByPeakGate && agentPauseGate.paused) {
		agentPauseGate.resume();
		gateOwnedByPeakGate = false;
	}
}

/**
 * Extension factory. `agentPauseGate` is a process-global singleton shared with
 * the TUI `/pause` command, main agents, in-process subagents, and advisors.
 * Each session (main and subagents) gets its own factory binding, so model
 * state below is per session while the gate itself stays process-wide.
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
	/** Set while we hold a fallback switch made this window, for the restore. */
	let switched:
		| { original: Model; originalThinking: ThinkingLevel | undefined; thinkingChanged: boolean; target: Model }
		| undefined;
	/** True while `pi.setModel` is in flight. */
	let switchInFlight = false;
	/** Set when a switch was attempted and refused this window; retried on reload/window end. */
	let switchFailed = false;

	/** This binding's membership in the process-wide gate want set. */
	const gateToken = Symbol("peak-gate-session");
	let wantsGate = false;
	let disposed = false;
	/** Context that created the timers currently armed (can differ after a switch). */
	let timerCtx: ExtensionContext | undefined;
	let unsubscribeGate: (() => void) | undefined;
	let sessionId: string | undefined;
	let sessionCwd: string | undefined;
	let isMainSession = false;
	/** A run is live; it may be parked on the gate. */
	let runActive = false;
	/** The current run saw the gate closed at least once (parked or interrupted). */
	let runSawPause = false;
	let gateHeldAt: number | undefined;
	let gateOpenedAt = 0;
	let waitInterruptEligible = false;
	let resumePending = false;
	let resumeReason: string | undefined;
	let resumeTimer: Timer | undefined;
	let resumeRetries = 0;
	let waitTimer: Timer | undefined;
	let resumeAttempts = 0;
	let activeWait: { id: string; startedAt: number } | undefined;
	const interruptedWaits = new Set<string>();

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

	const setGateWant = (want: boolean): void => {
		if (disposed) return;
		if (want !== wantsGate) {
			wantsGate = want;
			if (want) gateWanters.add(gateToken);
			else gateWanters.delete(gateToken);
		}
		// Sync even when the preference is unchanged: the user can release the
		// shared gate at any moment and the next heartbeat must re-engage it.
		syncPeakGate();
	};

	const writeMarkerIfMain = (): void => {
		if (!RESUME_ENABLED || !isMainSession || sessionId === undefined || sessionCwd === undefined) return;
		writeResumeMarker(sessionId, sessionCwd);
	};

	const cancelResumeTimer = (): void => {
		if (resumeTimer === undefined) return;
		try {
			(timerCtx ?? context)?.clearTimer(resumeTimer);
		} catch {
			// The owning session may already be disposed.
		}
		resumeTimer = undefined;
	};

	const cancelWaitTimer = (): void => {
		if (waitTimer === undefined) return;
		try {
			(timerCtx ?? context)?.clearTimer(waitTimer);
		} catch {
			// The owning session may already be disposed.
		}
		waitTimer = undefined;
	};

	/**
	 * A run settled while the gate held it (deadline, provider abort, or a host
	 * timeout that expired during the pause). The gate itself can only wake
	 * loops that are still parked, so once the session is idle the only way
	 * back is a fresh prompt. Waits for a short grace so a loop that woke on
	 * `resume()` can prove it is running and make this a no-op.
	 */
	const attemptResume = (): void => {
		const c = context;
		if (!RESUME_ENABLED || disposed || !isMainSession || !resumePending || c === undefined) return;
		debug(`resume: attempt (idle=${c.isIdle()} runActive=${runActive} retry=${resumeRetries})`);
		if (agentPauseGate.paused) {
			// Re-paused before the check ran; `handleGateOpened` re-arms it.
			holdProcess(true);
			return;
		}
		if (!c.isIdle()) {
			if (runActive) {
				// A fresh run is live (usually the parked loop woke); it owns the
				// session now. A `wait` that was already running is the one case
				// the gate cannot unblock, so end it and let the model continue.
				resumePending = false;
				resumeReason = undefined;
				clearResumeMarker();
				if (
					waitInterruptEligible &&
					activeWait !== undefined &&
					activeWait.startedAt <= gateOpenedAt
				) {
					scheduleWaitInterrupt(activeWait.id);
				}
				holdProcess(wantsGate);
				return;
			}
			// A restored session can still be initializing when the first check
			// lands (TUI load, large session file). Retry briefly instead of
			// waiting for the 30s heartbeat.
			if (resumeRetries < 20) {
				resumeRetries++;
				debug(`resume: session not idle yet; retrying in 500ms (${resumeRetries}/20)`);
				resumeTimer = c.setTimeout(() => {
					resumeTimer = undefined;
					attemptResume();
				}, 500);
				holdProcess(true);
				return;
			}
			holdProcess(wantsGate);
			return;
		}
		if (c.getAsyncJobSnapshot?.()?.running?.length) {
			// Background results auto-deliver and start the next turn themselves.
			holdProcess(wantsGate);
			return;
		}
		if (resumeAttempts >= MAX_RESUMES_PER_HOLD) {
			debug(`resume: giving up after ${resumeAttempts} attempts (${resumeReason ?? "unknown"})`);
			resumePending = false;
			resumeReason = undefined;
			clearResumeMarker();
			holdProcess(wantsGate);
			return;
		}
		resumeAttempts++;
		const reason = resumeReason ?? "gate-released";
		try {
			pi.sendUserMessage(RESUME_PROMPT, { attribution: "agent" });
		} catch (error) {
			debug(`resume: sendUserMessage failed: ${String(error)}`);
			c.ui.notify(`Peak gate: could not auto-resume the session (${String(error)})`, "warning");
			resumePending = false;
			resumeReason = undefined;
			holdProcess(wantsGate);
			return;
		}
		debug(`resume: injected a continuation prompt (${reason}, attempt ${resumeAttempts})`);
		c.ui.notify("Peak gate released: resuming the interrupted turn", "info");
		resumePending = false;
		resumeReason = undefined;
		clearResumeMarker();
		holdProcess(wantsGate);
	};

	const scheduleResumeCheck = (reason: string): void => {
		if (!RESUME_ENABLED || disposed || !isMainSession || context === undefined) return;
		if (!resumePending) resumeRetries = 0;
		resumePending = true;
		resumeReason = reason;
		if (resumeTimer !== undefined) return;
		const c = context;
		resumeTimer = c.setTimeout(() => {
			resumeTimer = undefined;
			attemptResume();
		}, RESUME_GRACE_MS);
		// A headless run may settle the moment the gate opens; keep it alive
		// until the continuation prompt has actually been injected.
		holdProcess(true);
	};

	const scheduleWaitInterrupt = (waitId: string): void => {
		if (
			!RESUME_ENABLED ||
			disposed ||
			!isMainSession ||
			waitTimer !== undefined ||
			interruptedWaits.has(waitId) ||
			context === undefined
		) {
			return;
		}
		const c = context;
		waitTimer = c.setTimeout(() => {
			waitTimer = undefined;
			const still = context;
			if (disposed || still === undefined || agentPauseGate.paused) return;
			if (activeWait?.id !== waitId || interruptedWaits.has(waitId)) return;
			if (still.isIdle()) {
				scheduleResumeCheck("wait-ended");
				return;
			}
			if (still.hasPendingMessages()) return; // the queued steer already cuts the wait
			interruptedWaits.add(waitId);
			try {
				pi.sendUserMessage(WAIT_RESUME_PROMPT, { deliverAs: "aside", attribution: "agent" });
			} catch (error) {
				debug(`resume: wait interrupt failed: ${String(error)}`);
				return;
			}
			debug("resume: interrupted an in-flight wait after gate release");
			still.ui.notify("Peak gate released: interrupting the pending wait so the turn continues", "info");
		}, WAIT_INTERRUPT_DELAY_MS);
	};

	const handleGateClosed = (): void => {
		if (disposed || !isMainSession) return;
		debug(`gate: closed (run=${runActive} queued=${context?.hasPendingMessages() ?? false})`);
		gateHeldAt ??= Date.now();
		waitInterruptEligible = false;
		resumeAttempts = 0;
		if (runActive) {
			runSawPause = true;
			writeMarkerIfMain();
		}
		if (context?.hasPendingMessages()) writeMarkerIfMain();
	};

	const handleGateOpened = (): void => {
		if (disposed || !isMainSession || context === undefined) return;
		const now = Date.now();
		const heldFor = gateHeldAt === undefined ? 0 : now - gateHeldAt;
		debug(
			`gate: opened (held=${heldFor}ms run=${runActive} idle=${context.isIdle()} queued=${context.hasPendingMessages()} pendingResume=${resumePending})`,
		);
		gateHeldAt = undefined;
		gateOpenedAt = now;
		waitInterruptEligible = heldFor >= WAIT_INTERRUPT_MIN_HOLD_MS;
		const c = context;

		if (resumePending) {
			scheduleResumeCheck(resumeReason ?? "gate-released");
			return;
		}
		if (c.isIdle() && c.hasPendingMessages()) {
			// A steer/follow-up queued while idle never starts a turn on its own —
			// whether it was queued before or after the gate closed.
			scheduleResumeCheck("queued-work");
			return;
		}
		if (runActive && !c.isIdle()) {
			// The parked loop woke and owns the session; a stale marker must not
			// fire later. A pre-existing `wait` may still hold the turn hostage.
			clearResumeMarker();
			if (
				waitInterruptEligible &&
				activeWait !== undefined &&
				activeWait.startedAt <= gateOpenedAt
			) {
				scheduleWaitInterrupt(activeWait.id);
			}
			return;
		}
		if (c.isIdle()) clearResumeMarker();
	};

	const initSession = (ctx: ExtensionContext): void => {
		context = ctx;
		sessionId = ctx.sessionManager.getSessionId();
		// The session's recorded cwd, not the process cwd: resuming from another
		// directory must still match the marker written by the original run.
		sessionCwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;
		isMainSession = ctx.agent?.kind === "main";
		runActive = false;
		runSawPause = false;
		gateHeldAt = agentPauseGate.paused ? Date.now() : undefined;
		waitInterruptEligible = false;
		resumePending = false;
		resumeReason = undefined;
		resumeRetries = 0;
		resumeAttempts = 0;
		activeWait = undefined;
		interruptedWaits.clear();
		cancelResumeTimer();
		cancelWaitTimer();
		if (!isMainSession || !RESUME_ENABLED) return;
		const marker = readResumeMarker();
		if (marker === undefined) return;
		if (marker.sessionId !== sessionId) return;
		if (marker.cwd !== undefined && marker.cwd !== sessionCwd) return;
		resumePending = true;
		resumeReason = "restart";
		debug(
			`resume: marker for session ${sessionId} (age ${Math.round((Date.now() - marker.at) / 1000)}s)`,
		);
		if (!agentPauseGate.paused) scheduleResumeCheck("restart");
	};

	/**
	 * Resolve the next usable model from omp's `retry.fallbackChains` for
	 * `model`. Returns undefined when no chain is configured (fallback is
	 * opt-in) or when every candidate is itself a remote DeepSeek model, which
	 * would not escape peak pricing. Throws are absorbed: a missing settings
	 * singleton simply means "not configured".
	 */
	const resolveFallbackTarget = (model: Model): FallbackTarget | undefined => {
		const registry = context?.modelRegistry;
		if (registry === undefined) return undefined;
		try {
			const chains = getRetryFallbackChains(pi.pi.settings);
			const modelLookup = {
				find: (provider: string, id: string): Model | undefined => registry.find(provider, id),
				hasProvider: (provider: string): boolean => registry.hasProvider(provider),
			};
			const resolution = {
				chains,
				getModelRole: (role: string): string | undefined => pi.pi.settings.getModelRole(role),
				modelLookup,
			};
			const selector = formatRetryFallbackSelector(model, pi.getThinkingLevel());
			const chainKey = resolveRetryFallbackChainKey(resolution, selector, model);
			if (chainKey === undefined) return undefined;
			for (const candidate of findRetryFallbackCandidates(resolution, chainKey, selector, model)) {
				const target = modelLookup.find(candidate.provider, candidate.id);
				if (target === undefined) continue;
				if (isGatedModel(target)) continue; // still peak-billed DeepSeek
				return { model: target, thinkingLevel: candidate.thinkingLevel };
			}
			return undefined;
		} catch (error) {
			debug(`fallback: retry.fallbackChains unavailable: ${String(error)}`);
			return undefined;
		}
	};

	/**
	 * Switch the session to its configured fallback model. Called only while
	 * the gate is already engaged, so no DeepSeek call can start while the
	 * async switch is in flight; a successful switch releases the gate through
	 * its own `apply`, a refusal keeps it parked.
	 */
	const startFallback = (model: Model): void => {
		if (switched !== undefined || switchInFlight || switchFailed) return;
		const target = resolveFallbackTarget(model);
		if (target === undefined) {
			// Not configured (or only remote DeepSeek candidates): park.
			debug(`fallback: no usable retry.fallbackChains entry for ${modelLabel(model)}; staying paused`);
			return;
		}
		switchInFlight = true;
		const original = model;
		const originalThinking = pi.getThinkingLevel();
		void (async () => {
			try {
				const ok = await pi.setModel(target.model);
				if (!ok) {
					switchFailed = true;
					debug(`fallback: setModel(${modelLabel(target.model)}) refused (missing API key?); staying paused`);
					context?.ui.notify(
						`DeepSeek peak window: fallback model ${modelLabel(target.model)} is unusable; calls stay paused`,
						"warning",
					);
					return;
				}
				const thinkingChanged =
					target.thinkingLevel !== undefined && target.thinkingLevel !== originalThinking;
				if (thinkingChanged && target.thinkingLevel !== undefined) pi.setThinkingLevel(target.thinkingLevel);
				switched = { original, originalThinking, thinkingChanged, target: target.model };
				switchFailed = false;
				debug(`fallback: switched ${modelLabel(original)} -> ${modelLabel(target.model)} (retry.fallbackChains)`);
				context?.ui.notify(
					`DeepSeek peak window: using fallback ${modelLabel(target.model)} (retry.fallbackChains)`,
					"info",
				);
				apply(Date.now());
			} catch (error) {
				switchFailed = true;
				debug(`fallback: setModel threw: ${String(error)}`);
			} finally {
				switchInFlight = false;
			}
		})();
	};

	/** Undo a fallback switch once the window is over (or the user opted out). */
	const restoreIfSwitched = (): void => {
		if (switched === undefined) return;
		const { original, originalThinking, thinkingChanged, target } = switched;
		switched = undefined;
		if (context?.model !== target) {
			// The user picked another model while we were on fallback; leave it alone.
			debug("fallback: model changed elsewhere; skipping restore");
			return;
		}
		void pi
			.setModel(original)
			.then(ok => {
				if (!ok) {
					debug(`fallback: restore of ${modelLabel(original)} refused`);
					return;
				}
				if (thinkingChanged && originalThinking !== undefined) pi.setThinkingLevel(originalThinking);
				debug(`fallback: restored ${modelLabel(original)}`);
				context?.ui.notify(`Peak window over: restored ${modelLabel(original)}`, "info");
			})
			.catch(error => debug(`fallback: restore threw: ${String(error)}`));
	};

	/** Pause decision for a point in time: clock, manual override, session model. */
	const shouldPause = (now: number): boolean => {
		if (!enabled) return false;
		if (manual === "pause") return true;
		if (manual === "resume") return false;
		if (!isPeak(windows, now)) return false;
		const model = context?.model;
		return model !== undefined && isGatedModel(model);
	};

	/** Reconcile the gate with the clock and the session model. Idempotent. */
	const apply = (now: number): void => {
		if (disposed) return;
		const inWindow = enabled && (manual === "pause" ? true : manual === "resume" ? false : isPeak(windows, now));
		const model = context?.model;
		const gated = model !== undefined && isGatedModel(model);

		// Out of the window (or manual resume): hand the session back first so
		// the gate decision below sees the restored DeepSeek model.
		if (!inWindow && switched !== undefined) restoreIfSwitched();

		const want = inWindow && (manual === "pause" || gated);
		const wasHolding = holding;
		setGateWant(want);
		// Any session's claim keeps the process-wide gate closed; report the
		// shared state rather than only this binding's preference.
		holding = gateWanters.size > 0 && agentPauseGate.paused;
		holdProcess(holding || resumePending);
		// A run may have settled outside a pause transition (for example a
		// provider abort right after the gate opened); the heartbeat catches it.
		if (!agentPauseGate.paused && resumePending) scheduleResumeCheck(resumeReason ?? "gate-released");

		// While gated inside a window, hand off to the configured fallback model.
		if (inWindow && manual !== "pause" && gated && switched === undefined) startFallback(model as Model);

		const next = nextTransition(windows, now);
		const until = next === undefined ? "" : ` until ${utcLabel(next)}`;
		let status: string | undefined;
		if (holding) status = `⏸ peak-gate${until}`;
		else if (switched !== undefined) status = `⏸ peak-gate ↓${context?.model?.id ?? "fallback"}${until}`;
		context?.ui.setStatus("peak-gate", status);
		debug(
			`apply: want=${want} holding=${holding} wasHolding=${wasHolding} gate=${agentPauseGate.paused} model=${modelLabel(model)} gated=${gated} switched=${switched === undefined ? "no" : modelLabel(switched.target)} next=${next === undefined ? "none" : utcLabel(next)} windows=${describeWindows(windows)}`,
		);
		if (holding === wasHolding) return;
		if (holding) {
			const release = next === undefined ? "" : `; releases ${utcLabel(next)}`;
			if (manual === "pause") {
				context?.ui.notify(`Peak gate: LLM calls paused manually${release}`, "info");
			} else {
				const fallback = model !== undefined ? resolveFallbackTarget(model) : undefined;
				const fallbackNote =
					fallback === undefined
						? "; no fallback configured in retry.fallbackChains"
						: `; will use ${modelLabel(fallback.model)} (retry.fallbackChains)`;
				context?.ui.notify(
					`DeepSeek peak window (${describeWindows(windows)}) for ${modelLabel(model)}: LLM calls paused${release}${fallback === undefined ? fallbackNote : ""}`,
					"info",
				);
			}
		} else if (switched === undefined) {
			const why = !enabled
				? "disabled"
				: manual === "resume"
					? "resumed manually"
					: isPeak(windows, now)
						? "no remote DeepSeek model active"
						: "outside the DeepSeek peak window";
			context?.ui.notify(`LLM calls resumed (${why})`, "info");
		}
		// A release caused by a successful fallback switch is announced by
		// startFallback itself, so no generic resume message here.
	};

	/** Arm the precise edge timer plus the heartbeat re-derivation. */
	const arm = (ctx: ExtensionContext): void => {
		context = ctx;
		const clearCtx = timerCtx ?? ctx;
		if (edgeTimer) {
			try {
				clearCtx.clearTimer(edgeTimer);
			} catch {
				// A prior session may already be disposed.
			}
		}
		if (heartbeat) {
			try {
				clearCtx.clearTimer(heartbeat);
			} catch {
				// A prior session may already be disposed.
			}
		}
		edgeTimer = undefined;
		heartbeat = undefined;
		timerCtx = ctx;
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

	pi.on("session_start", (_event, ctx) => {
		initSession(ctx);
		arm(ctx);
	});
	pi.on("session_switch", (_event, ctx) => {
		initSession(ctx);
		arm(ctx);
	});
	pi.on("session_shutdown", () => {
		disposed = true;
		cancelResumeTimer();
		cancelWaitTimer();
		const clearCtx = timerCtx;
		if (edgeTimer !== undefined) {
			try {
				clearCtx?.clearTimer(edgeTimer);
			} catch {
				// Already disposed.
			}
			edgeTimer = undefined;
		}
		if (heartbeat !== undefined) {
			try {
				clearCtx?.clearTimer(heartbeat);
			} catch {
				// Already disposed.
			}
			heartbeat = undefined;
		}
		// A host timeout can abort the parked run and dispose the session before
		// the gate ever opens. Keep the marker for that case; an ordinary quit
		// (no pending resume) drops it so a later resume does not surprise anyone.
		if (isMainSession && !resumePending) clearResumeMarker();
		unsubscribeGate?.();
		unsubscribeGate = undefined;
		if (wantsGate) {
			wantsGate = false;
			gateWanters.delete(gateToken);
		}
		syncPeakGate();
		holdProcess(false);
		context = undefined;
	});

	unsubscribeGate = agentPauseGate.onChange(paused => {
		if (paused) handleGateClosed();
		else handleGateOpened();
	});

	// Re-derive at run start so a model change (or a window that opened while
	// idle) takes effect on the next call instead of waiting out the heartbeat.
	pi.on("agent_start", (_event, ctx) => {
		if (disposed) return;
		const wasPending = resumePending;
		runActive = true;
		runSawPause = agentPauseGate.paused;
		resumePending = false;
		resumeReason = undefined;
		resumeRetries = 0;
		cancelResumeTimer();
		cancelWaitTimer();
		// Only the main session owns the marker; a subagent starting a run must
		// not erase the main session's pending restart hint.
		if (isMainSession) clearResumeMarker();
		if (agentPauseGate.paused) {
			gateHeldAt ??= Date.now();
			writeMarkerIfMain();
		}
		debug(`agent_start: main=${isMainSession} gate=${agentPauseGate.paused} wasPendingResume=${wasPending}`);
		apply(Date.now());
	});

	pi.on("agent_end", (event, ctx) => {
		if (disposed) return;
		runActive = false;
		if (!isMainSession) return;
		const last = event.messages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		const aborted = last?.stopReason === "aborted";
		const userAbort = aborted && last !== undefined && isUserInterruptAbort(last);
		const automatic = event.willContinue === true || event.awaitingAsyncWork === true;
		debug(
			`agent_end: aborted=${aborted} userAbort=${userAbort} automatic=${automatic} pauseSeen=${runSawPause} idle=${ctx.isIdle()} pending=${ctx.hasPendingMessages()}`,
		);
		if (aborted && !userAbort && !automatic && runSawPause) {
			// A deadline, provider abort, or host timeout expired while the run
			// was parked. No loop remains to wake when the gate opens.
			writeMarkerIfMain();
			scheduleResumeCheck("aborted-run");
		} else if (userAbort || automatic) {
			resumePending = false;
			resumeReason = undefined;
			cancelResumeTimer();
			clearResumeMarker();
		} else if (!ctx.hasPendingMessages()) {
			clearResumeMarker();
		}
		runSawPause = false;
	});

	pi.on("tool_execution_start", event => {
		if (event.toolName === "wait") activeWait = { id: event.toolCallId, startedAt: Date.now() };
	});
	pi.on("tool_execution_end", event => {
		if (activeWait?.id === event.toolCallId) activeWait = undefined;
		interruptedWaits.delete(event.toolCallId);
	});

	// Cache warming replays a real request outside the agent loop. It cannot be
	// parked, so stop it for the duration of a hold instead of billing a warm
	// request at peak rates. The warmer resumes on the next real request.
	pi.on("cache_warming_decision", () => {
		if (!enabled || !shouldPause(Date.now())) return;
		debug("cache warming: stopped during a peak-gate hold");
		return { action: "stop" as const };
	});

	// Advisory slip detector. The gate parks every agent loop before its model
	// call, so a request that reaches this hook while the gate should be closed
	// on this model came from a path the gate cannot park (`/btw`, title
	// generation, remote compaction). This hook cannot refuse it: returning a
	// payload is the only lever, and a thrown error is swallowed by the runner.
	// Warn (throttled) so a billed call during a pause is visible instead of
	// silent — and never abort the session, which would not stop the request it
	// was reacting to.
	pi.on("before_provider_request", (_event, ctx) => {
		if (!enabled || quiet) return;
		const now = Date.now();
		if (!shouldPause(now) || now - lastNotifyAt <= NOTIFY_COOLDOWN_MS) return;
		lastNotifyAt = now;
		debug("slip: a non-parked provider request reached the wire during a window");
		ctx.ui.notify(
			`A provider request ran during the DeepSeek peak window (${describeWindows(windows)}) for ${modelLabel(context?.model)}; the gate covers agent-loop calls only`,
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
					switchFailed = false;
					arm(ctx);
					ctx.ui.notify(`Peak gate reloaded from ${source}: ${describeWindows(windows)}`, "info");
					break;
				}
				default: {
					const next = nextTransition(windows, now);
					const model = ctx.model;
					const modelLine =
						model === undefined
							? "none (no model set)"
							: isGatedModel(model)
								? `${modelLabel(model)} - GATED (remote DeepSeek)`
								: `not gated - ${gatedReason(model)}`;
					let fallbackLine: string;
					if (switched !== undefined) {
						fallbackLine = `applied: ${modelLabel(switched.original)} -> ${modelLabel(switched.target)}`;
					} else {
						const target = model !== undefined && isGatedModel(model) ? resolveFallbackTarget(model) : undefined;
						fallbackLine =
							target === undefined
								? "not configured (retry.fallbackChains)"
								: `configured: ${modelLabel(target.model)}`;
					}
					ctx.ui.notify(
						[
							`peak gate: ${enabled ? "enabled" : "disabled (OMP_PEAK_GATE=off or config)"}`,
							`windows: ${describeWindows(windows)} (${source})`,
							`model: ${modelLine}`,
							`fallback: ${fallbackLine}`,
							`now: ${isPeak(windows, now) ? "PEAK window" : "off-peak"}${shouldPause(now) ? " - LLM calls paused" : ""}`,
							`gate: ${agentPauseGate.paused ? (holding ? "engaged by peak-gate" : "engaged elsewhere (/pause)") : "open"}`,
							`run: ${runActive ? (runSawPause ? "live (pause observed)" : "live") : "idle"}${activeWait === undefined ? "" : " - wait tool active"}`,
							`resume: ${
								!RESUME_ENABLED
									? "disabled (OMP_PEAK_GATE_RESUME=0)"
									: resumePending
										? `armed: ${resumeReason ?? "pending"}`
										: "watching"
							}`,
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
