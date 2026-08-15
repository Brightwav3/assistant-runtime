/**
 * The handoff's view of session control, satisfied by the live realtime adapter.
 *
 * Realtime Core is told nothing about handoff: it exposes open, activate, close, and which
 * session is active, and the policy — when to prepare, how long to wait, when to abort —
 * lives on this side of the boundary. This file is the whole of the translation.
 */

import type { HandoffSessionController } from "./contracts.js";

/** The slice of `RealtimeCoreAdapter` a handoff needs. Narrow on purpose: it is not its owner. */
export interface RealtimeSessionOwner {
  openReplacement(): Promise<string>;
  prefillSession(sessionId: string, context: string): Promise<void>;
  activateSession(sessionId: string): void;
  closeSession(sessionId: string): Promise<void>;
}

export function createRealtimeHandoffController(owner: RealtimeSessionOwner): HandoffSessionController {
  return {
    open: () => owner.openReplacement(),
    prefill: (sessionId, context) => owner.prefillSession(sessionId, context),
    // Synchronous all the way down, by contract: no await may separate one session giving up
    // audio from the next taking it.
    activate: (sessionId) => owner.activateSession(sessionId),
    close: (sessionId) => owner.closeSession(sessionId),
  };
}
