/**
 * The conversation currently being had, made readable by the *delegated text model*.
 *
 * Semantic memories answer "what is true about this user". This answers "what did we
 * actually just say", which is a different question and the one a clarification needs.
 * Extraction runs once, when the conversation ends, so until then the turns are the only
 * record of the current conversation that exists — and after a handoff they are the only
 * record of what was said before the swap, because the replacement session was given a
 * summary rather than the words.
 *
 * Scoped to the live logical session, supplied by the runtime and never by the model. A
 * model that could name a session id could read other conversations.
 *
 * What comes back is what somebody said. It is evidence, not instruction, and is tainted
 * accordingly — the same rule the delegated memory tools work under.
 */

import type { EpisodeRuntime, EpisodeTurn } from "memory-core";
import type { ExecutionOutcome, ToolDeclaration, ToolHandler } from "tool-system";

export const CONVERSATION_RECALL_TOOL = "conversation_recall";

export const CONVERSATION_RECALL_LIMITS = {
  maxTurns: 50,
  defaultTurns: 20,
  maxQueryLength: 200,
  /** Per turn. A single rambling turn must not crowd out every other turn. */
  maxTurnCharacters: 300,
  maxTotalCharacters: 4_000,
} as const;

export interface ConversationRecallOptions {
  episodes: Pick<EpisodeRuntime, "listTurns">;
  /** The live logical session. Bound by the runtime; a handoff does not change it. */
  session: () => string | undefined;
}

export function conversationRecallDeclaration(): ToolDeclaration {
  return {
    name: CONVERSATION_RECALL_TOOL,
    version: "0.1.0",
    description:
      "Reads what was actually said in the conversation happening right now, including anything said before the session was replaced. Read-only. Use it when the user refers back to something from this conversation — 'what did I say I liked', 'which one did I mean' — rather than guessing from the summary.",
    parameters: {
      query: { type: "string", description: "Words to look for, in the user's own language. Omit to read the most recent turns.", maxLength: CONVERSATION_RECALL_LIMITS.maxQueryLength },
      limit: { type: "integer", description: "How many turns to return.", minimum: 1, maximum: CONVERSATION_RECALL_LIMITS.maxTurns },
    },
    required: [],
    sideEffect: "read_only",
    guards: { timeoutMs: 5_000 },
  };
}

/** Diacritics folded, because a Czech query typed without them must still match what was said. */
function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function matches(turn: EpisodeTurn, tokens: string[]): boolean {
  if (!tokens.length) return true;
  const text = fold([turn.text, turn.verbatim, turn.meaning].filter(Boolean).join("\n"));
  return tokens.some((token) => text.includes(token));
}

function render(turn: EpisodeTurn): string {
  const evidence = turn.verbatim && turn.meaning && turn.verbatim !== turn.meaning
    ? `verbatim: ${turn.verbatim}\nmeaning: ${turn.meaning}`
    : turn.verbatim ?? turn.meaning ?? turn.text;
  const text = evidence.length > CONVERSATION_RECALL_LIMITS.maxTurnCharacters
    ? `${evidence.slice(0, CONVERSATION_RECALL_LIMITS.maxTurnCharacters)}…`
    : evidence;
  // The confidence marker is carried through rather than dropped: a turn the transcriber
  // was unsure of must not be quoted back to the user as though it were verbatim.
  const flag = turn.transcriptConfidence === "unreliable" ? " (uncertain transcript)" : "";
  return `[turnId=${turn.turnId} sequence=${turn.sequence}] ${turn.speaker}${flag}: ${text}`;
}

export function conversationRecallHandler(options: ConversationRecallOptions): ToolHandler {
  return async (args): Promise<ExecutionOutcome> => {
    const sessionId = options.session();
    if (!sessionId) return { kind: "result", content: "No conversation is open.", taint: "external" };

    const query = typeof args.query === "string" ? args.query.slice(0, CONVERSATION_RECALL_LIMITS.maxQueryLength) : "";
    const requested = typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.min(CONVERSATION_RECALL_LIMITS.maxTurns, Math.max(1, Math.trunc(args.limit)))
      : CONVERSATION_RECALL_LIMITS.defaultTurns;
    const tokens = fold(query).split(/\s+/).filter((token) => token.length > 1);

    const turns = await options.episodes.listTurns(sessionId);
    // Filtered first, then the most recent kept: a match early in a long conversation is
    // exactly what a clarification is reaching for, but "recent" still breaks the tie.
    const selected = turns.filter((turn) => turn.text.trim() && matches(turn, tokens)).slice(-requested);
    if (!selected.length) {
      return { kind: "result", content: query ? "Nothing in this conversation matched." : "This conversation has no turns yet.", taint: "external" };
    }

    const lines: string[] = [];
    let total = 0;
    let dropped = 0;
    // Oldest first, but trimmed from the oldest end, so the newest turns always survive.
    for (const turn of [...selected].reverse()) {
      const line = render(turn);
      if (total + line.length > CONVERSATION_RECALL_LIMITS.maxTotalCharacters) { dropped += 1; continue; }
      total += line.length;
      lines.unshift(line);
    }
    if (dropped) lines.unshift(`(${dropped} earlier turns omitted for length)`);

    return { kind: "result", content: lines.join("\n"), taint: "external" };
  };
}
