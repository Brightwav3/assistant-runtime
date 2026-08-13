# Hardware smoke test

Proves the native path end to end on real hardware:

```text
double clap → microphone → Gemini Live → speaker → memory survives a restart
```

Automated tests cover everything except the physical devices. This is the part
CI can never run, so it is recorded here by hand.

The explicit native realtime tool probe is documented separately in
[`docs/realtime-tools-smoke-test.md`](./realtime-tools-smoke-test.md). It is
not enabled by this general hardware path and must be injected deliberately.

## Prerequisites

| Requirement | Check |
| --- | --- |
| Node 22+ | `node --version` |
| ffmpeg and ffplay on PATH | `where ffplay` — install with `winget install Gyan.FFmpeg` |
| A Gemini API key | put in ignored `.env` as `GEMINI_API_KEY=<key>` |
| A working capture device | `./check-microphone.ps1 -List` |
| Built cores | every core publishes from `dist/`, so build them first |

## 1. Verify the microphone before anything else

A device that opens but returns digital silence is the most common reason a live
test appears to hang: activation never fires, and nothing reports an error.

```powershell
./check-microphone.ps1 -Device "<device name>"
```

- **PASS** — audio reached the activation threshold.
- **WARN** — audio arrives but stayed below the threshold. Clap louder, raise the
  Windows input level, or lower `activation.amplitudeThreshold` in `config.json`.
- **FAIL** — digital silence. Check the hardware mute switch and the Windows input
  level. Virtual devices (webcam, phone, streaming cables) return silence whenever
  their source application is not running.

The **first capture from a cold device is often silent** while it spins up. If the
first run fails, run it a second time before believing it.

## 2. Configure

```powershell
Copy-Item config.example.json config.json
```

**Leave `activation.device` unset.** Windows exposes two different names for the
same microphone, and only one of them works here:

| Interface | Example name | Used by |
| --- | --- | --- |
| DirectShow | `Mikrofon (Logitech G432 Gaming Headset)` | ffmpeg, the check script |
| WASAPI | `Mikrofon` | Activation Core, `config.json` |

Putting the DirectShow name in `config.json` fails with
`No microphone found matching "..."`. The WASAPI name is usually shared by
several devices, so it cannot identify one either. Omitting `activation.device`
selects the system default, which is the only unambiguous choice. Set it only
when the default is the wrong device, and then use the name marked `*` by
`./check-microphone.ps1 -List`.

`config.json` is git-ignored and never leaves the machine.

## 3. Provide the key

```powershell
Copy-Item .env.example .env
notepad .env
```

Put the key after `GEMINI_API_KEY=` and save the file. `.env` is git-ignored;
`start-jarvis.ps1` also accepts an explicit process variable or its legacy
`.runtime\gemini-api-key.txt` fallback.

## 4. Preflight without speaking

```powershell
node dist/cli/main.js capabilities
node dist/cli/main.js health
```

`capabilities` must report `nativeRealtime: true` and a `realtime` component with
`nativeAudio`, `interruption` and a `16000Hz/1ch` input format. Before start,
every component reports `degraded: not started` — that is expected, not a fault.

## 5. Run the assistant

```powershell
./start-jarvis.ps1
```

The launcher verifies the build, runs the playback preflight and then starts.
`playback.preflight` must report `ok: true` before activation is possible.

## 6. What to record

Run through each step and write down what actually happened.

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| 1 | Clap twice | `activation.detected` in the event stream | **PASS** 2026-08-12, fired reliably on repeated attempts |
| 2 | — | `realtime.session.started` | **PASS** |
| 3 | Say a sentence | `realtime.transcript.final` with `source: "input"` | **PASS** |
| 4 | — | Assistant answers through the speaker | **PASS**, audible |
| 5 | Interrupt mid-answer | `realtime.output.interrupted`, audio stops immediately | **PASS**, audio stopped on interruption |
| 6 | Say "remember that I ..." | conversation summary written to memory | **PASS** |
| 7 | Wait out `inactivityMs` | interaction ends by itself | **PASS** |
| 8 | Ctrl+C, restart, ask about the fact | the assistant still knows it | **PASS**, memory survived a restart |
| 9 | `node dist/cli/main.js memory list` | the summary is present | **PASS** |

## Known limitations to confirm or refute

These are recorded in the architecture baseline as unverified. The point of this
test is to turn each one into a fact.

1. Real microphones can occasionally lose speech detection. **Not observed.**
   Activation fired on every attempt during the first hardware run.
2. `realtime.session.closed` currently requires a new activation rather than
   reopening on its own. **Still open, and worse than described:** on the first
   hardware run the provider closed the session immediately after the greeting,
   twice in a row, with `chunks: 0` and no `session.error`. A later run on the
   same configuration worked. The cause is unexplained; the close code and
   reason are now recorded so a recurrence can be diagnosed instead of guessed.
3. Summaries do not infer preferences or facts; they only summarise turns.
4. The modular Scribe → Intelligence → Voice path has never run on hardware.
   **Still open.** Every result above came from the native realtime path.

## Resetting between runs

```powershell
./reset-memory.ps1
```

Deletes the durable memory database so a run starts from nothing.
