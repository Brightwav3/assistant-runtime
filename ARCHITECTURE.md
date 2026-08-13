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
