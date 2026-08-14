# Echo cancellation hardware test

Proves that the assistant can hold a conversation **on open speakers** without
hearing itself.

```text
Gemini output → speaker → room → microphone → echo canceller → Gemini input
```

The failure this test exists to disprove was measured on 2026-08-14: the
assistant's own Czech greeting returned through the microphone, Gemini's voice
activity detection read it as user speech, and the assistant interrupted itself
before the conversation could start. The captured echo was transcribed as
`Jak wam pomóc?` and `Як вам можу помогти?` — phonetic renderings of
`jak vám mohu pomoci`.

Everything except the physical devices is covered by offline tests. This is the
part no test can run.

## Prerequisites

Everything in [`hardware-smoke-test.md`](./hardware-smoke-test.md), plus:

| Requirement | Check |
| --- | --- |
| Speakers, **not** headphones | headphones make the test pass for the wrong reason |
| `echoCancellation` in `config.json` | see below |
| A built `aec-system` | `cd ../aec-system; npm run build` |

## 1. Configure

```json
"echoCancellation": {
  "enabled": true,
  "processor": "auto",
  "tailMs": 400,
  "minErleDb": 6,
  "recoveryFrames": 25,
  "recordDir": "..\\.runtime\\aec"
}
```

`processor` takes three values, and which one you set is the experiment:

| Value | Behaviour | What it proves |
| --- | --- | --- |
| `auto` | adaptive filter, falling back to the gate whenever it is not measurably cancelling | the intended production behaviour |
| `adaptive` | cancellation only, full duplex always | what the filter really achieves on your hardware, including when it fails |
| `gate` | suppression only, no voice barge-in | that the self-interruption loop is gone, with certainty |

`recordDir` writes the played, captured, and cleaned streams to disk for offline
analysis. It records your microphone, so it is off by default and worth turning
off again when you are done.

## 2. Run

```powershell
./start-jarvis.ps1
```

## 3. What to record

Speakers audible, at a normal conversational volume.

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| 1 | Clap twice, let the assistant greet you | it finishes its greeting without interrupting itself | **PASS** 2026-08-14 |
| 2 | Watch the log during the greeting | `echo.metrics` with `gateSuppressing: true` | |
| 3 | Say a sentence after it stops | transcribed as your speech, once | |
| 4 | Read the transcripts back | no transcript is a phonetic rendering of the assistant's own words | **PASS** at `suppressionGain: 0`; **FAILED** at 0.2, which transcribed the assistant's own sentence as the user's |
| 5 | After ~2 s of assistant speech | `echo.fallback.adaptive` with an `erleDb` figure | |
| 6 | Interrupt mid-answer by speaking | audio stops | **PASS** 2026-08-14, via `bargeInThreshold` rather than cancellation |
| 7 | Let a long answer run | `erleDb` in later `echo.metrics` has not collapsed toward 0 | |
| 8 | Ctrl+C | `echo.recording.stopped` with the session totals | |

Step 7 is the clock-drift question the whole native-backend decision rests on. A
figure that starts high and decays over a minute is the drift table happening on
real hardware, not a fault in the run.

Step 6 is the one that fails by design under `processor: "gate"`. Record it as
expected rather than as a defect.

## 4. Analyse the recording

Three headerless `pcm_s16le` files per session, in `recordDir`:

```text
<sessionId>.reference-24000.pcm   what the assistant played
<sessionId>.capture-16000.pcm     what the microphone heard
<sessionId>.cleaned-16000.pcm     what Gemini was given
```

Listen to them:

```powershell
ffplay -f s16le -ar 16000 -ac 1 "..\.runtime\aec\<sessionId>.cleaned-16000.pcm"
```

The cleaned stream should contain your voice and not the assistant's.

Re-run the canceller offline over the same audio, without the assistant, and try
other settings against a real recording instead of a simulated echo path:

```powershell
node ..\aec-system\dist\src\cli.js process --reference "..\.runtime\aec\<sessionId>.reference-24000.pcm" --capture "..\.runtime\aec\<sessionId>.capture-16000.pcm" --reference-rate 24000 --out cleaned.pcm --measure-from-ms 5000
```

The reported `attenuationDb`, `estimatedDelayMs`, and `state` are the first
measurements of this runtime against real hardware. Every figure recorded so far
comes from a simulated echo path.

Compare `estimatedDelayMs` against the 150–300 ms the Bluetooth analysis
predicted. If the estimate never converges, the reference and capture clocks are
further apart than the search window allows, and that is a finding worth having.

## Known limitations to confirm or refute

1. **Clock drift.** Measured at 50 ppm the filter falls from 58 dB to 12 dB over
   twenty seconds, in simulation. Whether that happens on this hardware, and how
   fast, is unmeasured.
2. **The 400 ms tail** comes from the published Bluetooth latency range, not from
   a measurement of this gate on a device.
3. **Non-linear echo** from a speaker driven loud enough to distort cannot be
   modelled by a linear filter at all. Turn the volume up until the assistant
   starts hearing itself again, and record where that is.
4. **Activation still receives raw audio** on purpose, so a double clap works
   while the assistant is speaking. Confirm that it does.
