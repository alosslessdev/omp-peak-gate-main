# omp-peak-gate

Park remote DeepSeek LLM calls while DeepSeek's peak-pricing window is open —
with opt-in fallback to your configured next model.

DeepSeek bills full rate Mon–Fri **01:00–04:00** and **06:00–10:00 UTC**. This
plugin engages the same process-global `agentPauseGate` the TUI `/pause` command
uses at those boundaries, so:

- in-flight provider streams finish (already billed),
- no new model call starts while the window is open,
- every agent loop **parks** instead of aborting — queued prompts and steering
  messages deliver normally once the window closes.

**Scope: only remote DeepSeek models.** The gate engages only when the session's
current model has `deepseek` in its provider, model id or name **and** is served
off this machine. Everything else keeps running during the window:

- other models (Claude, GPT, your default model, …) — never gated,
- DeepSeek checkpoints running locally — Ollama, llama.cpp, LM Studio, vLLM and
  friends (loopback `baseUrl` or a known local provider id) — never gated, they
  are not billed at DeepSeek peak rates.

`/peak-gate pause` still pauses every model regardless of scope.

**Fallback (opt-in).** If the gated model has an entry in oh-my-pi's own
`retry.fallbackChains` settings, the session switches to the next usable model
at the window's start instead of parking, and switches back when the window
closes. No chain configured → the gate parks as before; there is nothing to set
in this plugin. Candidates that are themselves remote DeepSeek models are
skipped (they would not escape peak pricing); a local DeepSeek checkpoint in the
chain is a valid, free target.

The gate decision is a pure function of the wall clock, the session model and a
static window table, so suspend/resume, clock jumps and timer jitter cannot
drift it. An exact edge timer engages/releases at the boundary; a 30-second
heartbeat re-derives state (and notices model changes).

## Install

```bash
# local checkout / development (symlinked, edits are live)
omp plugin link /path/to/omp-peak-gate

# git
omp plugin install github:<user>/omp-peak-gate

# marketplace (this repo ships .omp-plugin/marketplace.json)
/marketplace add <user>/omp-peak-gate
/marketplace install peak-gate@omp-peak-gate

# npm (after publishing)
omp plugin install omp-peak-gate
```

Check it landed: `omp plugin list`, then `/peak-gate status` in a session.

Do not also keep a copy at `~/.omp/agent/extensions/peak-gate.ts` — both paths
load, and the gate would be registered twice.

## Commands

| Command                                  | Effect                                                   |
| ---------------------------------------- | -------------------------------------------------------- |
| `/peak-gate`                             | Show state, windows, model scope, fallback, next boundary |
| `/peak-gate pause`                       | Hold LLM calls paused until the next window boundary      |
| `/peak-gate resume`                      | Release now, skip the current window (restore a fallback) |
| `/peak-gate reload`                      | Re-read the config file and re-arm the timers             |

While the gate is held, the status line shows `⏸ peak-gate until <UTC>`; while
running on a fallback model it shows `⏸ peak-gate ↓<model> until <UTC>`.
`pause` pauses every model regardless of scope; `resume` releases the gate and
switches back to the original DeepSeek model if a fallback was applied.

## Configuration

`~/.omp/agent/peak-gate.json` (agent dir follows `PI_CODING_AGENT_DIR`):

```json
{
  "windows": [
    { "startMinute": 60, "endMinute": 240, "weekdays": [1, 2, 3, 4, 5] },
    { "startMinute": 360, "endMinute": 600, "weekdays": [1, 2, 3, 4, 5] }
  ]
}
```

- `startMinute` / `endMinute` are UTC minutes of day, half-open `[start, end)`;
  `startMinute` must be less than `endMinute` (a midnight-crossing window is two
  entries). `endMinute: 1440` means midnight.
- `weekdays` uses `Date#getUTCDay` numbering (0 = Sunday). Omit it for daily.
- `{ "enabled": false }` disables the plugin without uninstalling it.

### Fallback (opt-in, configured in omp itself)

Fallback uses oh-my-pi's standard `retry.fallbackChains` — nothing plugin-side
to configure. In `~/.omp/agent/config.yml` (or project `.omp/config.yml`):

```yaml
retry:
  fallbackChains:
    deepseek/deepseek-v4-flash:
      - xiaomi/mimo-v2.6-flash:high
      - anthropic/claude-sonnet-4
    default:
      - ollama/qwen3:8b
```

At the window's start the gated model's chain is walked (same resolution core
uses on provider errors: exact model key, provider wildcard, model role, then
`default`) and the first usable non-remote-DeepSeek model takes over. Without
an entry the gate parks instead — fallback stays opt-in.

Environment overrides:

| Variable                     | Effect                                                            |
| ---------------------------- | ----------------------------------------------------------------- |
| `OMP_PEAK_GATE=off`          | Disable the gate for this process                                 |
| `OMP_PEAK_GATE_WINDOWS=JSON` | Replace the window table (`[{"startMinute":60,"endMinute":240}]`) |
| `OMP_PEAK_GATE_QUIET=1`      | Suppress the "a call slipped through" warning                     |
| `OMP_PEAK_GATE_KEEPALIVE=0`  | Let a parked headless run exit instead of waiting out the window  |
| `OMP_PEAK_GATE_DEBUG=/path`  | Append decision lines to a log file                               |

## What is and is not gated

Gated (the gate is polled before each model call and each tool call): the main
agent, in-process subagents, advisors, tool loops — i.e. everything that spends
through an agent loop — **but only while the session model is a remote DeepSeek
model** (see scope above). The gate itself is process-global: a session parked
on DeepSeek holds every loop in the process until the window closes or the
fallback switch releases it.

Not gated: a few side channels stream outside any agent loop (`/btw` side turns,
session title generation, remote compaction). `before_provider_request` cannot
veto them — that hook may only replace the payload and a thrown error is
swallowed — so they are surfaced as a throttled warning instead of being billed
silently. Use `OMP_PEAK_GATE_QUIET=1` to silence it.

Never gated: non-DeepSeek models and locally served models — they do not match
the scope, so no window can pause them. To pause everything manually, use
`/peak-gate pause`; to change when the window applies, edit `windows`.

## Layout

```
package.json                     omp.extensions -> ./extensions/peak-gate.ts
extensions/peak-gate.ts          the extension module
.omp-plugin/marketplace.json     catalog so the repo is its own marketplace
```
