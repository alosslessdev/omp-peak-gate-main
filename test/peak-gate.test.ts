/**
 * Gate-transition and resume-watchdog tests.
 *
 * The extension is loaded against a mocked oh-my-pi runtime so every edge case
 * can be driven deterministically: a fake clock, fake timers, a fake session
 * context, and a fake process-global pause gate. The extension's real
 * decision code runs unchanged.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENT_DIR = mkdtempSync(join(tmpdir(), "peak-gate-test-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.OMP_PEAK_GATE_WINDOWS = "[]";
process.env.OMP_PEAK_GATE_KEEPALIVE = "0";
process.env.OMP_PEAK_GATE_QUIET = "1";
delete process.env.OMP_PEAK_GATE_RESUME;

class FakeGate {
	#paused = false;
	#listeners = new Set<(paused: boolean) => void>();

	get paused(): boolean {
		return this.#paused;
	}

	pause(): boolean {
		if (this.#paused) return false;
		this.#paused = true;
		for (const listener of this.#listeners) listener(true);
		return true;
	}

	resume(): number | undefined {
		if (!this.#paused) return undefined;
		this.#paused = false;
		for (const listener of this.#listeners) listener(false);
		return 0;
	}

	onChange(listener: (paused: boolean) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}

class FakeScheduler {
	now = 1_700_000_000_000;
	#nextId = 1;
	#timers = new Map<number, { callback: () => void; due: number; interval?: number }>();

	setTimeout(callback: () => void, delay: number): number {
		const id = this.#nextId++;
		this.#timers.set(id, { callback, due: this.now + Math.max(0, delay) });
		return id;
	}

	setInterval(callback: () => void, delay: number): number {
		const id = this.#nextId++;
		this.#timers.set(id, { callback, due: this.now + Math.max(1, delay), interval: Math.max(1, delay) });
		return id;
	}

	clearTimer(id: number): void {
		this.#timers.delete(id);
	}

	advance(ms: number): void {
		const target = this.now + ms;
		for (;;) {
			let nextId: number | undefined;
			let nextDue = Number.POSITIVE_INFINITY;
			for (const [id, timer] of this.#timers) {
				if (timer.due <= target && timer.due < nextDue) {
					nextId = id;
					nextDue = timer.due;
				}
			}
			if (nextId === undefined) break;
			const timer = this.#timers.get(nextId);
			if (timer === undefined) break;
			this.now = timer.due;
			if (timer.interval !== undefined) timer.due = this.now + timer.interval;
			else this.#timers.delete(nextId);
			timer.callback();
		}
		this.now = target;
	}

	get pendingTimers(): number {
		return this.#timers.size;
	}
}

const gate = new FakeGate();

mock.module("@oh-my-pi/pi-agent-core", () => ({ agentPauseGate: gate }));
mock.module("@oh-my-pi/pi-coding-agent/session/messages", () => ({
	isUserInterruptAbort: (message: { errorMessage?: string }) => message.errorMessage === "Interrupted by user",
}));
mock.module("@oh-my-pi/pi-coding-agent/session/retry-fallback-chains", () => ({
	getRetryFallbackChains: () => undefined,
	formatRetryFallbackSelector: () => "",
	resolveRetryFallbackChainKey: () => undefined,
	findRetryFallbackCandidates: () => [],
}));

// The module is imported dynamically on purpose: `mock.module` must register
// the fake omp packages before the extension's static imports are evaluated.
const { default: deepseekPeakGate } = await import("../extensions/peak-gate.ts");

const deepseekModel = {
	provider: "deepseek",
	providerType: "openai",
	id: "deepseek-v4-flash",
	name: "DeepSeek V4 Flash",
	baseUrl: "https://api.deepseek.com",
};

interface SessionState {
	sessionId: string;
	idle: boolean;
	pending: boolean;
	jobs: { running: unknown[] } | null;
	kind: "main" | "sub";
	notifications: { message: string; level: string }[];
}

interface Harness {
	sent: { content: string; options: Record<string, unknown> | undefined }[];
	state: SessionState;
	scheduler: FakeScheduler;
	ctx: Record<string, unknown>;
	emit(event: string, payload?: unknown): Promise<unknown>;
	command(args: string): Promise<void>;
}

let activeHarnesses: Harness[] = [];
const realDateNow = Date.now;
let clock: FakeScheduler;

function makeHarness(options?: { sessionId?: string; kind?: "main" | "sub"; idle?: boolean }): Harness {
	const scheduler = new FakeScheduler();
	clock = scheduler;
	const state: SessionState = {
		sessionId: options?.sessionId ?? "session-1",
		idle: options?.idle ?? true,
		pending: false,
		jobs: null,
		kind: options?.kind ?? "main",
		notifications: [],
	};
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const sent: { content: string; options: Record<string, unknown> | undefined }[] = [];

	const ctx = {
		ui: {
			notify: (message: string, level: string) => state.notifications.push({ message, level }),
			setStatus: () => {},
		},
		mode: "tui",
		cwd: "/work",
		sessionManager: { getSessionId: () => state.sessionId, getCwd: () => "/work" },
		model: deepseekModel,
		modelRegistry: { find: () => undefined, hasProvider: () => false },
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		getAsyncJobSnapshot: () => state.jobs,
		agent: { kind: state.kind, id: "main", name: state.kind, depth: 0 },
		setTimeout: (callback: () => void, delay: number) => scheduler.setTimeout(callback, delay),
		setInterval: (callback: () => void, delay: number) => scheduler.setInterval(callback, delay),
		clearTimer: (id: number) => scheduler.clearTimer(id),
		abort: () => {},
	};

	const pi = {
		on: (event: string, handler: (payload: unknown, context: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, definition);
		},
		getThinkingLevel: () => "medium",
		setModel: async () => true,
		setThinkingLevel: () => {},
		sendUserMessage: (content: string, opts?: Record<string, unknown>) => {
			sent.push({ content, options: opts });
		},
		pi: {
			settings: {
				getModelRole: () => undefined,
			},
		},
	};

	deepseekPeakGate(pi as never);

	const harness: Harness = {
		sent,
		state,
		scheduler,
		ctx,
		async emit(event, payload = {}) {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) {
				const value = await handler(payload, ctx);
				if (value !== undefined) result = value;
			}
			return result;
		},
		async command(args) {
			const command = commands.get("peak-gate");
			if (command === undefined) throw new Error("peak-gate command not registered");
			await command.handler(args, ctx);
		},
	};
	activeHarnesses.push(harness);
	return harness;
}

const ABORTED = (errorMessage: string) => ({
	role: "assistant",
	stopReason: "aborted",
	errorMessage,
});
const NORMAL = { role: "assistant", stopReason: "stop", errorMessage: undefined };

async function boot(
	options?: Parameters<typeof makeHarness>[0],
): Promise<Harness & { startRun(): Promise<void>; endRun(message: unknown): Promise<void> }> {
	const harness = makeHarness(options);
	await harness.emit("session_start");
	return {
		...harness,
		async startRun() {
			harness.state.idle = false;
			await harness.emit("agent_start");
		},
		async endRun(message: unknown) {
			harness.state.idle = true;
			await harness.emit("agent_end", { type: "agent_end", messages: [message], willContinue: false });
		},
	};
}

beforeAll(() => {
	// `apply()` derives hold durations from the wall clock; keep it deterministic.
	clock = new FakeScheduler();
	Date.now = () => clock.now;
});

beforeEach(() => {
	// A marker is global; never let one test leak into the next.
	try {
		rmSync(join(AGENT_DIR, "peak-gate-resume.json"), { force: true });
	} catch {}
	if (gate.paused) gate.resume();
	activeHarnesses = [];
});

afterEach(async () => {
	for (const harness of activeHarnesses) {
		try {
			// The manual override is process-wide now; `/peak-gate reload` clears it
			// so one test's pause/resume cannot leak into the next.
			await harness.command("reload");
			await harness.emit("session_shutdown");
		} catch {}
	}
	activeHarnesses = [];
	if (gate.paused) gate.resume();
});

afterAll(() => {
	Date.now = realDateNow;
	rmSync(AGENT_DIR, { recursive: true, force: true });
});

describe("auto-resume after a gate hold", () => {
	test("injects one continuation prompt when the run was aborted during the pause", async () => {
		const h = await boot({ idle: false });
		await h.startRun();
		await h.command("pause");
		expect(gate.paused).toBe(true);
		await h.endRun(ABORTED("Deadline exceeded"));

		await h.command("resume");
		expect(h.sent).toHaveLength(0);

		h.scheduler.advance(399);
		expect(h.sent).toHaveLength(0);
		h.scheduler.advance(2);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.content).toContain("peak-gate pause");
		expect(h.sent[0]?.options).toMatchObject({ attribution: "agent" });
	});

	test("never resumes a deliberate user interrupt", async () => {
		const h = await boot({ idle: false });
		await h.startRun();
		await h.command("pause");
		await h.endRun(ABORTED("Interrupted by user"));

		await h.command("resume");
		h.scheduler.advance(2_000);
		expect(h.sent).toHaveLength(0);
	});

	test("does not resume a run that completed normally", async () => {
		const h = await boot({ idle: false });
		await h.startRun();
		await h.command("pause");
		await h.endRun(NORMAL);

		await h.command("resume");
		h.scheduler.advance(2_000);
		expect(h.sent).toHaveLength(0);
	});

	test("does nothing when the parked loop woke on its own", async () => {
		const h = await boot({ idle: false });
		await h.startRun();
		await h.command("pause");

		// The gate release wakes the parked loop: still live, not idle.
		h.state.idle = false;
		await h.command("resume");
		h.scheduler.advance(2_000);
		expect(h.sent).toHaveLength(0);

		await h.endRun(NORMAL);
		h.scheduler.advance(2_000);
		expect(h.sent).toHaveLength(0);
	});

	test("does nothing for an idle session that never had work", async () => {
		const h = await boot({ idle: true });
		await h.command("pause");
		await h.command("resume");
		h.scheduler.advance(2_000);
		expect(h.sent).toHaveLength(0);
	});

	test("drains steer/follow-up messages queued while an idle session was paused", async () => {
		const h = await boot({ idle: true });
		h.state.pending = true;
		await h.command("pause");
		await h.command("resume");
		h.scheduler.advance(500);
		expect(h.sent).toHaveLength(1);
	});

	test("drains messages queued after the gate already closed", async () => {
		const h = await boot({ idle: true });
		await h.command("pause");
		h.state.pending = true;
		await h.command("resume");
		h.scheduler.advance(500);
		expect(h.sent).toHaveLength(1);
	});

	test("never injects from a subagent session", async () => {
		const h = await boot({ idle: false, kind: "sub", sessionId: "sub-1" });
		await h.startRun();
		await h.command("pause");
		await h.endRun(ABORTED("Deadline exceeded"));
		await h.command("resume");
		h.scheduler.advance(2_000);
		expect(h.sent).toHaveLength(0);
	});

	test("re-arms the check when the first grace elapsed while the gate was still closed", async () => {
		const h = await boot({ idle: false });
		await h.startRun();
		await h.command("pause");
		await h.endRun(ABORTED("host timeout"));

		// The first check fires during the pause and must leave the intent armed.
		h.scheduler.advance(1_000);
		expect(h.sent).toHaveLength(0);

		await h.command("resume");
		h.scheduler.advance(500);
		expect(h.sent).toHaveLength(1);
	});
});

describe("in-flight wait handling", () => {
	test("ends an interruptible wait with an aside after a real hold", async () => {
		const h = await boot({ idle: false });
		await h.startRun();
		await h.emit("tool_execution_start", { toolCallId: "wait-1", toolName: "wait" });
		await h.command("pause");
		h.scheduler.advance(6_000); // a real hold, not a fallback blip
		await h.command("resume");
		expect(h.sent).toHaveLength(0);

		h.scheduler.advance(1_500);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.options).toMatchObject({ deliverAs: "aside", attribution: "agent" });

		await h.emit("tool_execution_end", { toolCallId: "wait-1", toolName: "wait" });
		h.scheduler.advance(2_000);
		expect(h.sent).toHaveLength(1);
	});

	test("does not interrupt a wait after a short (fallback-like) hold", async () => {
		const h = await boot({ idle: false });
		await h.startRun();
		await h.emit("tool_execution_start", { toolCallId: "wait-2", toolName: "wait" });
		await h.command("pause");
		await h.command("resume");
		h.scheduler.advance(2_000);
		expect(h.sent).toHaveLength(0);
	});

	test("does not interrupt a wait that started after the gate opened", async () => {
		const h = await boot({ idle: false });
		await h.startRun();
		await h.command("pause");
		h.scheduler.advance(6_000);
		await h.command("resume");
		await h.emit("tool_execution_start", { toolCallId: "wait-3", toolName: "wait" });
		h.scheduler.advance(2_000);
		expect(h.sent).toHaveLength(0);
	});
});

describe("side channels", () => {
	test("status renders the resume watchdog state", async () => {
		const h = await boot({ idle: true });
		await h.command("status");
		expect(h.state.notifications.at(-1)?.message).toContain("resume: watching");
	});

	test("stops cache warming while the gate is held", async () => {
		const h = await boot({ idle: true });
		expect(await h.emit("cache_warming_decision", {})).toBeUndefined();
		await h.command("pause");
		expect(await h.emit("cache_warming_decision", {})).toMatchObject({ action: "stop" });
		await h.command("resume");
		expect(await h.emit("cache_warming_decision", {})).toBeUndefined();
	});
});

describe("process-wide gate ownership", () => {
	test("an explicit resume releases the gate for every session", async () => {
		const first = await boot({ sessionId: "session-a", idle: true });
		const second = await boot({ sessionId: "session-b", idle: true });
		await first.command("pause");
		await second.command("pause");
		expect(gate.paused).toBe(true);

		await first.command("resume");
		expect(gate.paused).toBe(false);

		await second.command("resume");
		expect(gate.paused).toBe(false);
	});

	test("shutdown releases this session's claim without stranding the gate", async () => {
		const first = await boot({ sessionId: "session-c", idle: true });
		const second = await boot({ sessionId: "session-d", idle: true });
		await first.command("pause");
		await second.command("pause");
		await first.emit("session_shutdown");
		expect(gate.paused).toBe(true);
		await second.emit("session_shutdown");
		expect(gate.paused).toBe(false);
	});
});

describe("manual override across sessions", () => {
	/** Run `fn` with an explicit window table; the next binding reads it on load. */
	async function withWindows<K>(windows: string, fn: () => Promise<K>): Promise<K> {
		const previous = process.env.OMP_PEAK_GATE_WINDOWS;
		process.env.OMP_PEAK_GATE_WINDOWS = windows;
		try {
			return await fn();
		} finally {
			if (previous === undefined) delete process.env.OMP_PEAK_GATE_WINDOWS;
			else process.env.OMP_PEAK_GATE_WINDOWS = previous;
		}
	}

	test("a subagent session starting after /peak-gate resume does not re-pause the gate", async () => {
		const allDay = JSON.stringify([{ startMinute: 0, endMinute: 1440 }]);
		await withWindows(allDay, async () => {
			const main = await boot({ sessionId: "main-manual", idle: true });
			expect(gate.paused).toBe(true);

			await main.command("resume");
			expect(gate.paused).toBe(false);

			// Spawning a subagent creates another binding whose model + window
			// would make it want the shared gate closed.
			const sub = await boot({ sessionId: "sub-manual", kind: "sub", idle: true });
			expect(gate.paused).toBe(false);

			// Heartbeats re-derive state; the override must still win.
			sub.scheduler.advance(31_000);
			expect(gate.paused).toBe(false);
		});
	});

	test("a manual resume expires at the next window boundary", async () => {
		// The fake clock is 2023-11-14T22:13:20Z: Tuesday, minute 1333.
		const edges = JSON.stringify([
			{ startMinute: 0, endMinute: 1334, weekdays: [2] },
			{ startMinute: 1335, endMinute: 1440, weekdays: [2] },
		]);
		await withWindows(edges, async () => {
			const h = await boot({ sessionId: "main-boundary", idle: true });
			expect(gate.paused).toBe(true);

			await h.command("resume");
			expect(gate.paused).toBe(false);

			h.scheduler.advance(60_000); // out of the first window
			expect(gate.paused).toBe(false);

			h.scheduler.advance(60_000); // inside the next one: the gate returns
			expect(gate.paused).toBe(true);
		});
	});
});

describe("restart marker", () => {
	test("a resumed session gets one continuation prompt after a hard loss", async () => {
		writeFileSync(
			join(AGENT_DIR, "peak-gate-resume.json"),
			JSON.stringify({ sessionId: "session-restart", cwd: "/work", at: Date.now() }),
		);
		const h = await boot({ sessionId: "session-restart", idle: true });
		h.scheduler.advance(500);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.content).toContain("peak-gate pause");
	});

	test("keeps the marker when a host abort disposes the session before release", async () => {
		const h = await boot({ idle: false, sessionId: "session-disposed" });
		await h.startRun();
		await h.command("pause");
		await h.endRun(ABORTED("Deadline exceeded"));
		await h.emit("session_shutdown");
		const markerPath = join(AGENT_DIR, "peak-gate-resume.json");
		expect(existsSync(markerPath)).toBe(true);
		expect(JSON.parse(readFileSync(markerPath, "utf8")).sessionId).toBe("session-disposed");
	});

	test("waits for a restored session to finish initializing", async () => {
		writeFileSync(
			join(AGENT_DIR, "peak-gate-resume.json"),
			JSON.stringify({ sessionId: "session-restoring", cwd: "/work", at: Date.now() }),
		);
		const h = await boot({ sessionId: "session-restoring", idle: false });
		h.scheduler.advance(1_000);
		expect(h.sent).toHaveLength(0);
		h.state.idle = true;
		h.scheduler.advance(500);
		expect(h.sent).toHaveLength(1);
	});

	test("ignores a marker for another session", async () => {
		writeFileSync(
			join(AGENT_DIR, "peak-gate-resume.json"),
			JSON.stringify({ sessionId: "someone-else", cwd: "/work", at: Date.now() }),
		);
		const h = await boot({ sessionId: "session-restart-2", idle: true });
		h.scheduler.advance(500);
		expect(h.sent).toHaveLength(0);
	});
});
