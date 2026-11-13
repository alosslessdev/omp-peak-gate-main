# Changelog

## 0.3.1

- Fix `/peak-gate resume` being undone as soon as a subagent session starts.
  The gate is process-wide but the manual override was per session binding, so a
  subagent spawned after the command re-derived `want = true` from the window
  and re-paused the shared gate until the window closed. The override now lives
  on the process, every live session re-derives immediately, and it still
  expires at the next window boundary.
- Tests cover a subagent binding starting after a manual resume and the
  override expiring at a window edge.

## 0.3.0

- Automatic resume after a peak-gate pause: restart marker for a hard process
  loss, wait interruption, queued steer/follow-up draining, gate ownership
  refcounting across sessions, and cache warming stopped during a hold.
- Gate only remote DeepSeek models; opt-in fallback via `retry.fallbackChains`.

## 0.2.0

- Initial public release: pause remote DeepSeek calls during the published peak
  windows with `/peak-gate status|pause|resume|reload`.
