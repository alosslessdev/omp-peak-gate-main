# Session archive

Generated 2026-11-06T03:02:16.498Z from session `01a1aea8-a85b-7446-b141-fd18562e567d`.

## Layout

| Path | Contents |
| --- | --- |
| `manifest.json` | Index of everything below (counts, sizes, subagent list) |
| `session.jsonl` | The main session transcript, verbatim |
| `agents.json` | Live per-agent state captured while the session ran (model, system prompt, tools) |
| `jobs.json` | Background jobs: `completed` (recovered from transcripts) + `live` (running/recent at archive time) |
| `artifacts/` | Every file under the session artifact directory, verbatim |
| `viewer.html` | Standalone HTML viewer (all subagent sessions embedded) |

`artifacts/` is the important part: it holds each subagent's own
`<AgentId>.jsonl` transcript (recursively nested), the session's
`*.bash.log` / `*.eval.log` / `*.read.log` files with the **full, untruncated**
tool and background-job output, and `*.jsonl.tombstone` kill markers.

## Background jobs

2 completed jobs recovered from the transcripts (main + every subagent); full list in `jobs.json`. A live snapshot of running/recent jobs for Main is also included. Per-job output lives in the owning transcript and in `artifacts/*.log`.

## Subagents (0)

_No subagent sessions were recorded for this session._

## Totals

9 files, 5604157 bytes.
