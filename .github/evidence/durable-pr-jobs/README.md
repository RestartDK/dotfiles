# PR jobs UI captures

These images show isolated real Herdr and Pi sessions. The Jobs data comes from a private typed snapshot fixture, not GitHub. No model call occurs during capture.

`sidebar-before.png` uses the pinned Herdr 0.9.1 baseline. `sidebar-after.png` uses the patched package. Both images crop the same sidebar region from a 132-column, 42-row terminal. The fixture reports `+10231` and `-352`; the configured green and red stay unchanged.

`jobs-large-narrow.png` shows 120 fixture jobs in a 60-column, 30-row Herdr client. The header remains visible, and the final line counts the omitted output.

`pi-jobs-offline.png` shows the native Pi passive widget after the fixture becomes unavailable. Cached jobs stay visible with `OFFLINE / STALE`. This is an after-only image because the baseline has no Jobs widget.

The capture used a PTY, a VT screen parser, and a bitmap renderer. Raw terminal output, the private fixture, and complete proof logs remain local.
