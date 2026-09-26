import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { guardOutput, handleTurn, resumeAfterTool, startCall } from "../src";
import { clinic, ctx, hotel, realEstate, restaurant } from "./support";

const utterances = fc.oneof(
  fc.string({ maxLength: 60 }),
  fc.constantFrom(
    "",
    "yes",
    "no",
    "tomorrow",
    "5 pm",
    "80 lakh",
    "apartment",
    "emergency",
    "talk to a person",
    "what is the price?",
    "Rahul",
    "not interested",
    "3",
    "no, make it friday",
  ),
);

/**
 * Whatever the caller says (random strings included), for every template:
 * the engine never throws, never loops forever, never goes silent while the line is open,
 * and never produces text that would fail the output guard.
 */
describe("engine invariants (property-based)", () => {
  it.each([
    ["real estate", realEstate()],
    ["clinic", clinic()],
    ["hotel", hotel()],
    ["restaurant", restaurant()],
  ])("%s", (_, config) => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ text: utterances, llm: fc.boolean(), toolOk: fc.boolean() }), { maxLength: 25 }),
        (turns) => {
          let out = startCall(config, ctx, "fuzz");
          for (const turn of turns) {
            if (out.control === "hangup" || out.control === "transfer") break;
            out = handleTurn(out.session, config, { transcript: turn.text, llmError: turn.llm }, ctx);
            while (out.awaitingTool) {
              out = resumeAfterTool(
                out.session,
                config,
                turn.toolOk ? { ok: true } : { ok: false, error: "x" },
                ctx,
              );
            }
            if (out.control === "listen") {
              expect(out.speech.length).toBeGreaterThan(0);
              expect(out.prompt).not.toBeNull();
            }
            if (out.speech) expect(guardOutput(out.speech, { maxChars: 2000 }).ok).toBe(true);
          }
          if (out.session.ended) expect(out.session.outcome).not.toBeNull();
        },
      ),
      { numRuns: 300 },
    );
  });
});
