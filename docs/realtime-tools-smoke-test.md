# Native realtime tool smoke test

This probe verifies the explicit Mark I path:

```text
Gemini Live tool.requested
  -> RealtimeCoreAdapter
  -> ToolSystemRealtimeToolExecutor
  -> ToolRuntime validation/policy/guards
  -> allowlisted calc.exe launch
  -> Gemini function response
  -> spoken realtime response
```

The probe is manual-only. It is not part of `npm run verify`, it requires a
real microphone, speaker, Gemini credentials, and Windows Calculator, and it
must never be enabled by the default composition.

## Prerequisites

- Node.js 22 or newer.
- A working microphone and speaker.
- `ffplay.exe` on `PATH`.
- `.env` copied from `.env.example` with `GEMINI_API_KEY=<key>`; the file is ignored by Git.
- The repository dependencies installed.

## Run

From `C:\Users\Sajmon\Jarvis\assistant-runtime`:

```powershell
npm install
npm run build
npm run typecheck
npx tsx tests/probe-realtime-tool.ts
```

The probe creates exactly one catalogued capability, `open_app` with the
logical value `calculator` mapped to `calc.exe`. The Tool System policy and
process broker are explicitly allowlisted in the probe. The probe loads the
local `.env`; an already-set `GEMINI_API_KEY` process value takes precedence.
No key is printed or committed.

1. Wait for `{"type":"probe.ready",...}`.
2. Double-clap to activate the native realtime session.
3. Say `Open Calculator`.
4. Confirm Calculator opens and the assistant speaks its response.
5. Stop with `Ctrl+C` and confirm the process exits cleanly.

## Expected evidence

The JSON stream should include, in order, a successful connection, a
`realtime.tool.requested` event, a `realtime.tool.metrics` transition with
`requested: 1`, a `realtime.tool.metrics` transition with `completed: 1`, and
playback metrics. Tool argument values and the API key must not appear in the
trace.

Record the date, OS/device details, and the observed result separately if this
probe is run. Do not change `PROGRESS.md` to PASS without that real evidence.

## Failure checks

- Missing `GEMINI_API_KEY`: the probe stops before starting the runtime.
- No Calculator launch: inspect the Tool System/broker error; do not bypass the
  allowlist or call `spawn` from a tool handler.
- No `tool.requested`: confirm the session received the declaration and that
  Gemini was given the spoken request.
- No spoken response: inspect `realtime.playback.metrics` and `ffplay.exe`
  availability.
