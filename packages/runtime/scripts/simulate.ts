/**
 * Talk to an agent template in the terminal — the same runtime a phone call uses, without the phone.
 *
 *   pnpm simulate --template clinic-reception                 # deterministic (no LLM)
 *   pnpm simulate --template clinic-reception --llm gemini    # needs GEMINI_API_KEY
 *   pnpm simulate --template real-estate-ava --say "Rahul|apartment|80 lakh"
 *
 * Blocking tools succeed automatically; --fail-tools simulates an outage.
 */
import { createLLMProvider } from "@platform/ai";
import type { EngineContext } from "@platform/core";
import { getTemplate, instantiateTemplate, TEMPLATES } from "@platform/templates";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createRuntime, type RuntimeTurn } from "../src";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    template: { type: "string", default: "real-estate-ava" },
    llm: { type: "string", default: "none" },
    say: { type: "string" },
    "fail-tools": { type: "boolean", default: false },
    timezone: { type: "string", default: "Asia/Kolkata" },
  },
});

if (!getTemplate(values.template!)) {
  console.error(
    `Unknown template "${values.template}". Available: ${TEMPLATES.map((t) => t.key).join(", ")}`,
  );
  process.exit(1);
}
const config = instantiateTemplate(values.template!);
const llm =
  values.llm === "gemini" ? createLLMProvider("gemini", { gemini: process.env.GEMINI_API_KEY }) : null;
if (values.llm === "gemini" && !llm) {
  console.error("GEMINI_API_KEY is not set");
  process.exit(1);
}
const runtime = createRuntime({
  llm,
  tools: {
    run: async (call) => {
      const ok = !values["fail-tools"];
      console.log(dim(`  ⚙ ${call.tool} ${JSON.stringify(call.input)} → ${ok ? "ok" : "FAILED"}`));
      return ok ? { ok: true } : { ok: false, error: "simulated outage" };
    },
  },
});
const ctx = (): EngineContext => ({ now: new Date(), timezone: values.timezone!, defaultCountryCode: "91" });

function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

function show(t: RuntimeTurn): void {
  for (const call of t.output.backgroundTools) console.log(dim(`  ⚙ background ${call.tool}`));
  console.log(`\x1b[36m${config.agentName}:\x1b[0m ${t.speech}`);
  const m = t.metrics;
  console.log(
    dim(`  ${m.totalMs}ms · llm calls ${m.llmCalls} · ${m.deterministic ? "deterministic" : "llm"}`),
  );
}

async function main(): Promise<void> {
  console.log(
    dim(`Template: ${values.template} · LLM: ${values.llm} · empty line = silence · Ctrl+C to quit\n`),
  );
  let turn = await runtime.start(config, ctx(), `sim-${Date.now()}`);
  show(turn);
  const scripted = values.say?.split("|");
  const rl = scripted ? null : createInterface({ input: process.stdin, output: process.stdout });

  while (turn.output.control === "listen") {
    const line = scripted ? scripted.shift() : await rl!.question("\x1b[33mYou:\x1b[0m ");
    if (line === undefined) break;
    if (scripted) console.log(`\x1b[33mYou:\x1b[0m ${line}`);
    turn = await runtime.turn(config, turn.output.session, { transcript: line }, ctx());
    show(turn);
  }
  rl?.close();

  const s = turn.output.session;
  console.log(
    dim(
      `\n— ${turn.output.control === "transfer" ? `transferred to ${turn.output.transferTo}` : turn.output.control} —`,
    ),
  );
  console.log(dim(`outcome: ${s.outcome ?? "(in progress)"} · qualification: ${s.qualification}`));
  console.log(dim(`collected: ${JSON.stringify(s.collected)}`));
  if (s.pendingQuestions.length)
    console.log(dim(`follow-up questions: ${JSON.stringify(s.pendingQuestions)}`));
}

void main();
