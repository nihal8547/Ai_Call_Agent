/**
 * Talk to an agent template in the terminal (deterministic fallback path, no LLM, no phone).
 *
 *   pnpm --filter @platform/core simulate -- --template clinic-reception
 *   pnpm --filter @platform/core simulate -- --template real-estate-ava --say "Rahul|apartment|80 lakh"
 *
 * Blocking tools succeed automatically; add --fail-tools to simulate outages.
 */
import { getTemplate, instantiateTemplate, TEMPLATES } from "@platform/templates";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { type EngineContext, handleTurn, resumeAfterTool, startCall, type TurnOutput } from "../src";

const { values } = parseArgs({
  options: {
    template: { type: "string", default: "real-estate-ava" },
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
const ctx = (): EngineContext => ({ now: new Date(), timezone: values.timezone!, defaultCountryCode: "91" });
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function show(out: TurnOutput): TurnOutput {
  let o = out;
  for (;;) {
    for (const call of o.backgroundTools)
      console.log(dim(`  ⚙ background ${call.tool} ${JSON.stringify(call.input)}`));
    if (o.speech) console.log(`\x1b[36m${config.agentName}:\x1b[0m ${o.speech}`);
    if (!o.awaitingTool) break;
    const call = o.awaitingTool;
    const ok = !values["fail-tools"];
    console.log(dim(`  ⚙ ${call.tool} ${JSON.stringify(call.input)} → ${ok ? "ok" : "FAILED"}`));
    o = resumeAfterTool(
      o.session,
      config,
      ok ? { ok: true } : { ok: false, error: "simulated outage" },
      ctx(),
    );
  }
  return o;
}

async function main(): Promise<void> {
  console.log(
    dim(`Template: ${values.template} · fallback mode (no LLM) · empty line = silence · Ctrl+C to quit\n`),
  );
  let out = show(startCall(config, ctx(), `sim-${Date.now()}`));
  const scripted = values.say?.split("|");
  const rl = scripted ? null : createInterface({ input: process.stdin, output: process.stdout });

  while (out.control === "listen") {
    const line = scripted ? scripted.shift() : await rl!.question("\x1b[33mYou:\x1b[0m ");
    if (line === undefined) break;
    if (scripted) console.log(`\x1b[33mYou:\x1b[0m ${line}`);
    out = show(handleTurn(out.session, config, { transcript: line }, ctx()));
  }
  rl?.close();

  const s = out.session;
  console.log(dim(`\n— ${out.control === "transfer" ? `transferred to ${out.transferTo}` : out.control} —`));
  console.log(dim(`outcome: ${s.outcome ?? "(in progress)"} · qualification: ${s.qualification}`));
  console.log(dim(`collected: ${JSON.stringify(s.collected)}`));
  if (s.pendingQuestions.length)
    console.log(dim(`follow-up questions: ${JSON.stringify(s.pendingQuestions)}`));
}

void main();
