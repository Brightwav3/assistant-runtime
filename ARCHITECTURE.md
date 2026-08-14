# Architecture

```text
Activation adapter -> AssistantRuntime -> Native realtime adapter
                                 └----> Modular adapter (Scribe -> Intelligence -> Voice)
                                 └----> State adapter
```

`AssistantRuntime` is the sole cross-core coordinator. Components start in configured deterministic order and stop in reverse order. An interaction is `idle -> activating -> active -> ending`; failures transition to cleanup and cannot revive a removed interaction because callbacks compare the active interaction ID.

The runtime consumes interfaces defined in `src/contracts.ts`, not sibling implementation files. This retains provider and identity independence and makes all normal tests offline.

The native realtime boundary is:

```text
capture chunks -> 320-sample frameizer -> RealtimeCoreAdapter
                                     -> RealtimeSpeechSession
Gemini tool.requested -> RealtimeToolExecutor -> ToolRuntime
                      -> provider-specific tool result
```

The adapter owns a newest-500-ms pre-connect buffer and aggregate traces. Tool
validation, policy, guards, broker access, cancellation, and outcome rendering
remain in Tool System. The production composition supplies a safe read-only
catalogue (`get_time`, `calculate`, `uptime`, `system_status`) through the same
bridge. A caller-provided executor replaces that catalogue; side-effecting
capabilities such as `open_app` remain explicit opt-ins.

## Echo cancellation boundary

```text
provider output chunks -> PcmPlaybackController -> player
                                              └-> EchoGuard.pushPlayback (reference)
capture chunks -> frameizer -> EchoGuard.processCapture -> RealtimeSpeechSession
```

Both halves of the loop already passed through this repository, so composing AEC
System costs two calls and no new device ownership. Three decisions are worth
recording, because each was found by wiring it rather than by reasoning about it:

**The reference is scheduled by playback position, not arrival time.** The
provider streams a whole utterance in a burst and the player buffers it, so the
moment a chunk arrives is not the moment it is heard. Stamping chunks with
arrival time compresses the reference timeline against the capture timeline,
which puts the echo outside the delay estimator's search window and opens the
gate while the speaker is still talking. `EchoGuard` places each chunk at the end
of the one before it.

**An interruption retracts the reference.** Barge-in kills the player, and the
audio still queued is never heard. Without `dropReferenceFrom` the canceller
subtracts an echo that never arrives and the gate suppresses for the full
duration of speech the user interrupted precisely because they did not want to
hear it. That gap was added to AEC System's contract as a result.

**Activation still receives raw capture.** Only the provider stream is cleaned. A
double clap while the assistant is speaking is not echo, and gating it would make
the assistant unable to be activated by someone standing next to a speaker.

Suppression lifts for sound too loud to be echo, and the level that means is
measured rather than configured. The gate cannot tell the user from the
assistant; the microphone can, because echo arrives attenuated by the room while
the user does not. A decaying peak of the capture being suppressed gives the echo
level as this room and this microphone gain deliver it, frames loud enough to be
speech are excluded from it so a barge-in cannot raise the bar that admitted it,
and half a second of listening precedes any barge-in so the assistant's own voice
is never what unlocks the gate. An absolute threshold was tried first and was
wrong the moment anything about the room changed.

The fallback policy lives here rather than in AEC System, because choosing
between full duplex and certainty is a product decision, not an audio one. The
runtime holds both processors, uses the adaptive output while it reports a
sustained echo return loss enhancement, and hands over to the gate when it does
not — but only while the gate says playback is active, since with nothing playing
there is no echo to trade the user's voice for.

## Platform boundary

```text
createPlatformServices(process.platform) -> PlatformServices
                                            ├-> createActivationListener()  (ClapListener)
                                            ├-> createSpeechStack()         (stt/tts/output)
                                            └-> player                      (PcmPlayerSpec)
```

Shared composition never names a concrete platform implementation. It receives a
leaf and reads `capability.status`; an `unsupported` host yields `degraded`
microphone, playback, and modular components carrying a reason instead of a
crash or a silent mode change.

Two rules follow from this and are enforced by tests in
`tests/platform-neutrality.test.ts`:

1. Shared identifiers are platform-neutral. The realtime capture stream is
   `local-default-microphone`, and the shipped activation `sourceId` default
   matches it. Concrete device and provider names (`windows_speech_recognition`,
   `ffplay.exe`) live only inside the leaf and reach diagnostics through the
   leaf's own descriptors.
2. Shared realtime playback has no default player. `RealtimeCoreAdapter` takes an
   optional `PcmPlayerSpec`; when none is supplied it emits `playback.unavailable`
   and discards audio. It never falls back to the Windows executable.
   `verifyPlayback(player, sampleRate)` likewise refuses without a player rather
   than probing one host with another host's binary.

### Leaf loading: audited, unchanged on purpose

`factory.ts` imports the Windows leaf statically. That was audited rather than
changed, because lazy `import()` would buy nothing here: `composition.ts` already
imports `activation-core` directly for `ActivationRuntime` and
`DoubleClapProvider`, so the native `decibri` capture binding loads on any host
regardless of which leaf is selected. Neither `platform/windows.ts` nor
`platform/windows-player.ts` executes platform code at import time — they only
define a function and a constant — so the static import itself is inert.

Making `createPlatformServices()` async to enable lazy loading would change a
public contract and ripple through composition and tests, for no measured gain.
The real prerequisite is confirming that `decibri` imports at all on macOS and
Linux, which needs hardware this project does not have.
