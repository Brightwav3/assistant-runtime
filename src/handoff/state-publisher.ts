/**
 * Publishes handoff status so it is observable rather than inferred from silence.
 *
 * A handoff that nobody can see is indistinguishable from a handoff that never ran, and
 * both look the same from outside as a conversation that simply kept going. When one starts
 * failing repeatedly, the difference matters.
 *
 * State Core needs no new code for this. It is a generic keyed store with TTL, ownership
 * and subscriptions; handoff status is ordinary data written under a key prefix.
 */

import type { StatePublisher } from "../contracts.js";
import type { HandoffEvent } from "./contracts.js";

export type HandoffStatus = "idle" | "handoff_pending" | "handoff_active";

export const HANDOFF_STATE_KEYS = {
  logicalId: "assistant.session.logical_id",
  status: "assistant.session.handoff_state",
  reason: "assistant.session.handoff_reason",
} as const;

export class HandoffStatePublisher {
  public constructor(private readonly state: StatePublisher, private readonly assistantId: string) {}

  /** Subscribe this to the coordinator's event stream. */
  public async handle(event: HandoffEvent): Promise<void> {
    switch (event.type) {
      case "handoff.prepared":
        await this.write(event.identity.logicalSessionId, "handoff_pending", event.reason);
        return;
      case "handoff.committed":
        // The logical id is republished deliberately: it did not change, and a reader that
        // sees the physical swap should be able to confirm that from the state, not assume it.
        await this.write(event.identity.logicalSessionId, "handoff_active", event.reason);
        await this.write(event.identity.logicalSessionId, "idle", "");
        return;
      case "handoff.aborted":
      case "handoff.failed":
        await this.write(event.identity.logicalSessionId, "idle", event.failure);
        return;
      default:
        return;
    }
  }

  private async write(logicalId: string, status: HandoffStatus, reason: string): Promise<void> {
    const source = { sourceType: "system" as const, sourceId: this.assistantId };
    await this.state.set({ key: HANDOFF_STATE_KEYS.logicalId, value: logicalId, source });
    await this.state.set({ key: HANDOFF_STATE_KEYS.status, value: status, source });
    await this.state.set({ key: HANDOFF_STATE_KEYS.reason, value: reason, source });
  }
}
