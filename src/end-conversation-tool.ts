import type { ExecutionOutcome, ToolDeclaration, ToolHandler } from "tool-system";

export const END_CONVERSATION_TOOL = "end_conversation";

/**
 * Lets the assistant hand a shutdown request back to the host.
 *
 * The model may only ask. Tool System returns a `lifecycle` outcome, which it
 * explicitly does not act on, and the host decides whether to stop. That keeps a
 * spoken phrase from being able to terminate the process on its own — the model
 * must first hear an explicit confirmation, and the host must still agree.
 */
export function endConversationDeclaration(): ToolDeclaration {
  return {
    name: END_CONVERSATION_TOOL,
    version: "0.1.0",
    description:
      "Ends the conversation and shuts the assistant down. Call this ONLY after the user has asked to finish and has then explicitly confirmed when asked. Never call it on the first request, and never call it on your own initiative.",
    parameters: {
      reason: {
        type: "string",
        description: "The user's own words that asked for the shutdown, so the host can log why it stopped.",
        maxLength: 200,
      },
    },
    required: ["reason"],
    sideEffect: "local_state",
    // A repeated identical request inside the cooldown is an echo or a model retry, not a second decision.
    guards: { timeoutMs: 1_000, cooldownMs: 2_000 },
  };
}

export function endConversationHandler(): ToolHandler {
  return async (args): Promise<ExecutionOutcome> => ({
    kind: "lifecycle",
    action: "shutdown",
    reason: typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : "The user asked to end the conversation.",
  });
}
