import type { ExecutionOutcome, ToolDeclaration, ToolHandler } from "tool-system";
import type { EpisodeRuntime } from "memory-core";

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

export interface EndConversationOptions {
  episodes: Pick<EpisodeRuntime, "listTurns">;
  session: () => string | undefined;
}

const endRequest = /\b(to je vše|končíme|ukonč|vypni|už nic nepotřebuji)\b/iu;
const confirmation = /\b(ano|jo|potvrzuji|ukončete se|vypněte se)\b/iu;

export function endConversationHandler(options?: EndConversationOptions): ToolHandler {
  return async (args): Promise<ExecutionOutcome> => {
    if (options) {
      const sessionId = options.session();
      const turns = sessionId ? await options.episodes.listTurns(sessionId) : [];
      const recent = turns.slice(-6);
      const lastUser = [...recent].reverse().find((turn) => turn.speaker === "user");
      const priorUser = [...recent].reverse().find((turn) => turn.speaker === "user" && turn.turnId !== lastUser?.turnId);
      const askedConfirmation = recent.some((turn) => turn.speaker === "assistant" && /\b(ukončit|vypnout|skončit)\b/iu.test(turn.text));
      // In heard mode, episode text is the voice-to-voice model's literal reconstruction;
      // that model understands the audio while the provider transcript may be language-blind
      // garbage. Do not switch this to realtime.transcript.final without first configuring
      // and measuring provider language recognition. The semantic `meaning` field is still
      // excluded here because it is a paraphrase, not literal evidence.
      if (!lastUser || !priorUser || !endRequest.test(priorUser.text) || !askedConfirmation || !confirmation.test(lastUser.text)) {
        return { kind: "error", error: { code: "confirmation_required", message: "A prior end request and a later explicit confirmation are required.", retryable: false } };
      }
    }
    return {
    kind: "lifecycle",
    action: "shutdown",
    reason: typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : "The user asked to end the conversation.",
    };
  };
}
