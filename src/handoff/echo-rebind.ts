/**
 * Re-points echo cancellation at the session that now owns playback.
 *
 * The canceller models the path between what we played and what the microphone hears. A
 * commit changes that path, and a filter still adapted to the old one stops recognising the
 * assistant's own voice — at which point the assistant answers itself, confidently, and
 * every other part of the system reports success.
 *
 * `beginSession` is the existing reset: it clears the adaptive filter, the gate, and the
 * reference timeline. Nothing new is invented here; what is new is that a commit calls it.
 */

import type { HandoffEvent } from "./contracts.js";

/** The slice of `EchoGuard` this needs. Narrow on purpose: it is not the guard's owner. */
export interface EchoReferenceOwner {
  beginSession(sessionId: string): void;
}

export interface EchoRebinderOptions {
  guard?: EchoReferenceOwner;
  /** Called after the reference is rebound, before any replacement audio should play. */
  onRebound?: (physicalSessionId: string) => void;
}

/**
 * Returns a handoff event listener that rebinds on commit.
 *
 * Only `handoff.committed` rebinds. Rebinding on `prepare` would reset the filter while the
 * *current* session is still speaking through it — trading a stale reference for no
 * reference, which is worse and happens every attempt rather than only on the ones that
 * commit.
 */
export function createEchoRebinder(options: EchoRebinderOptions): (event: HandoffEvent) => void {
  return (event: HandoffEvent): void => {
    if (event.type !== "handoff.committed") return;
    const sessionId = event.identity.activePhysicalSessionId;
    options.guard?.beginSession(sessionId);
    options.onRebound?.(sessionId);
  };
}
