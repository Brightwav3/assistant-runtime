# Known Issues

- `realtime.session.closed` requires a new activation. The session does not
  re-establish itself.

- Automatic conversation summaries do not infer intelligent preferences or facts.
  Extraction is a proposal path into Memory Core, which validates and decides.

- The modular Scribe → Intelligence → Voice path is not hardware-verified. Only the
  realtime Gemini Live path has been verified on real hardware.

- Side-effecting tools remain explicit opt-ins. Registration is not permission.

- Barge-in is unavailable for the first half second of a session, while the echo
  level is being measured. See
  [ADR 0003](docs/decisions/0003-barge-in-thresholds.md).

- The barge-in constants are empirical, tuned against one host's hardware, and have
  no derivation. Behaviour on other microphones differs in ways only hardware
  testing reveals.

- A delegated result delivered with the `silent` policy is invisible unless
  something reads the trace.

- `src/tool-bridge.ts` grows as more cores meet. Keeping it thin is a discipline the
  compiler cannot enforce — see
  [ADR 0001](docs/decisions/0001-zero-imports-between-cores.md).
