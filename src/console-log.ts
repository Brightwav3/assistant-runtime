type ConsoleLineWriter = (line: string) => void;

function asText(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Converts the verbose runtime trace into a compact operator-facing console log. */
export function createHumanTrace(writeLine: ConsoleLineWriter = (line) => process.stdout.write(`${line}\n`)): (event: Record<string, unknown>) => void {
  let outputText = "";
  let completedTools = 0;
  let failedTools = 0;
  let cancelledTools = 0;

  const print = (line: string): void => {
    if (line.trim()) writeLine(line);
  };

  const flushOutput = (label = "Gemini"): void => {
    const text = outputText.trim();
    if (text) print(`${label}: ${text}`);
    outputText = "";
  };

  return (event) => {
    const type = asText(event.type);

    if (type === "realtime.input.metrics" || type === "realtime.playback.chunk" || type === "realtime.playback.metrics" || type === "playback.spawned" || type === "playback.stderr" || type === "playback.closed" || type === "realtime.stream.ended") return;

    if (type === "playback.preflight") {
      print(event.ok === true ? "Audio výstup připraven." : `CHYBA audio výstupu: ${asText(event.message) || "neznámá chyba"}`);
      return;
    }

    if (type === "realtime.tools.discovered") {
      const tools = Array.isArray(event.tools) ? event.tools.map(asText).filter(Boolean) : [];
      print(tools.length > 0 ? `Nástroje: ${tools.join(", ")}.` : "Nástroje: žádné.");
      return;
    }

    if (type === "activation.detected") {
      print("Aktivace zachycena.");
      return;
    }

    if (type === "realtime.connect.started") {
      print("Připojuji Gemini…");
      return;
    }

    if (type === "realtime.connect.succeeded") {
      print("Gemini připojeno.");
      return;
    }

    if (type === "realtime.greeting.sent") {
      print("Jarvis je připraven.");
      return;
    }

    if (type === "runtime.started") {
      print("Jarvis běží. Dvojitě tleskni pro aktivaci. Ctrl+C ukončí program.");
      return;
    }

    if (type === "realtime.transcript.final" && event.source === "input") {
      const text = asText(event.text).trim();
      if (text) print(`Slyšel jsem: ${text}`);
      return;
    }

    if (type === "realtime.transcript.partial" && event.source === "output") {
      outputText += asText(event.text);
      return;
    }

    if (type === "realtime.transcript.final" && event.source === "output") {
      outputText += asText(event.text);
      flushOutput();
      return;
    }

    if (type === "realtime.output.audio_completed") {
      flushOutput();
      return;
    }

    if (type === "realtime.output.interrupted") {
      flushOutput("Gemini (přerušeno)");
      return;
    }

    if (type === "realtime.tool.requested") {
      const tool = asText(event.tool);
      print(tool ? `Používám nástroj: ${tool}.` : "Používám nástroj.");
      return;
    }

    if (type === "realtime.tool.metrics") {
      const completed = asCount(event.completed);
      const failed = asCount(event.failed);
      const cancelled = asCount(event.cancelled);
      if (completed > completedTools) print("Nástroj dokončen.");
      if (failed > failedTools) print("Nástroj selhal.");
      if (cancelled > cancelledTools) print("Nástroj zrušen.");
      completedTools = Math.max(completedTools, completed);
      failedTools = Math.max(failedTools, failed);
      cancelledTools = Math.max(cancelledTools, cancelled);
      return;
    }

    // Delegation is the one thing the operator cannot infer from the conversation: the
    // gap between "I'll look into that" and the answer is otherwise silent, and silence
    // looks identical whether the background model is working or has died.
    if (type === "delegation.accepted") {
      print("Deleguji na pozadí…");
      return;
    }

    if (type === "delegation.tool") {
      const tool = asText(event.tool);
      const outcome = asText(event.outcome);
      print(`  └ pozadí: ${tool || "nástroj"} → ${outcome === "result" ? "ok" : outcome} (${asCount(event.durationMs)} ms)`);
      return;
    }

    if (type === "delegation.completed") {
      print("Výsledek delegace dorazil.");
      return;
    }

    if (type === "delegation.delivery.queued") {
      print("  └ čekám, až domluvím, pak výsledek předám.");
      return;
    }

    if (type === "delegation.delivery.degraded") {
      // Worth surfacing: it means the provider would not take the result natively.
      print("  └ POZOR: nativní vložení kontextu nedostupné, používám náhradní cestu.");
      return;
    }

    if (type === "delegation.delivery.sent") {
      print("  └ výsledek předán do konverzace.");
      return;
    }

    if (type === "delegation.delivery.dropped") {
      print(`  └ výsledek zahozen: ${asText(event.reason) || "neznámý důvod"}.`);
      return;
    }

    if (type === "delegation.failed" || type === "delegation.cancelled") {
      const failure = event.failure as { code?: unknown } | undefined;
      if (asText(failure?.code) === "MODEL_RATE_LIMITED") {
        print("Delegace selhala: vyčerpaná kvóta nebo rychlostní limit API. Zkuste to za chvíli, nebo použijte jiný model či klíč.");
        return;
      }
      print(`Delegace ${type === "delegation.failed" ? "selhala" : "zrušena"}: ${asText(failure?.code) || "neznámý kód"}.`);
      return;
    }

    if (type === "delegation.disabled") {
      print(`Delegace vypnuta: ${asText(event.reason) || "neznámý důvod"}.`);
      return;
    }

    if (type === "delegation.created" || type === "delegation.started" || type === "delegation.progress" || type === "delegation.session.bound" || type === "tools.voice.catalogue") return;

    if (type === "realtime.session.closed") {
      flushOutput();
      print("Realtime relace ukončena.");
      return;
    }

    if (type === "tools.install.failed" || type === "realtime.connect.failed" || type === "realtime.greeting.failed" || type === "realtime.input.failed" || type === "realtime.tool.result.failed" || type === "realtime.session.error" || type === "playback.error" || type === "playback.stdin.error" || type === "runtime.error" || type === "modular.error") {
      print(`CHYBA: ${asText(event.message) || "neznámá chyba"}`);
    }
  };
}
