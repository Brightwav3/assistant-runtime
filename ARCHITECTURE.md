# Architecture

```text
Activation adapter -> AssistantRuntime -> Native realtime adapter
                                 └----> Modular adapter (Scribe -> Intelligence -> Voice)
                                 └----> State adapter
```

`AssistantRuntime` is the sole cross-core coordinator. Components start in configured deterministic order and stop in reverse order. An interaction is `idle -> activating -> active -> ending`; failures transition to cleanup and cannot revive a removed interaction because callbacks compare the active interaction ID.

The runtime consumes interfaces defined in `src/contracts.ts`, not sibling implementation files. This retains provider and identity independence and makes all normal tests offline.
