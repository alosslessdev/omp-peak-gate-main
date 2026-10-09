# omp-peak-gate

Pause every oh-my-pi LLM call while DeepSeek's peak-pricing window is open.

DeepSeek bills full rate Mon–Fri **01:00–04:00** and **06:00–10:00 UTC**. This plugin
freezes the whole process at those boundaries by engaging the same process-global
`agentPauseGate` the TUI `/pause` command uses, so:

- in-flight provider streams finish (already billed),
- no new model call starts while the window is open,
- every agent loop **parks** instead of aborting — queued prompts and steering
  messages deliver normally once the window closes.

The decision is a pure function of the wall clock and a static window table, so
suspend/resume, clock jumps and timer jitter cannot drift it. An exact edge timer
engages/releases at the boundary; a 30-second heartbeat re-derives state.

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
| `/peak-gate`                             | Show state, windows, current period, next boundary        |
| `/peak-gate pause`                       | Hold LLM calls paused until the next window boundary      |
| `/peak-gate resume`                      | Release now, skip the current window (until its boundary) |
| `/peak-gate reload`                      | Re-read the config file and re-arm the timers             |

While the gate is held, the status line shows `⏸ peak-gate until <UTC>`.

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
through an agent loop.

Not gated: a few side channels stream outside any agent loop (`/btw` side turns,
session title generation, remote compaction). `before_provider_request` cannot
veto them — that hook may only replace the payload and a thrown error is
swallowed — so they are surfaced as a throttled warning instead of being billed
silently. Use `OMP_PEAK_GATE_QUIET=1` to silence it.

The gate pauses **all** models during a window, not only DeepSeek ones. Narrow it
by editing `windows`, or disable it and rely on `/peak-gate pause` manually.

## Layout

```
package.json                     omp.extensions -> ./extensions/peak-gate.ts
extensions/peak-gate.ts          the extension module
.omp-plugin/marketplace.json     catalog so the repo is its own marketplace
```
