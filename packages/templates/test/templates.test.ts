import { AgentConfig } from "@platform/shared";
import { describe, expect, it } from "vitest";
import { instantiateTemplate, TEMPLATES } from "../src";

describe("agent templates", () => {
  it.each(TEMPLATES.map((t) => [t.key, t] as const))("%s is a valid AgentConfig", (_, t) => {
    const result = AgentConfig.safeParse(t.config);
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it("have unique keys", () => {
    expect(new Set(TEMPLATES.map((t) => t.key)).size).toBe(TEMPLATES.length);
  });

  it("can be personalised", () => {
    const cfg = instantiateTemplate("clinic-reception", { businessName: "Smile Care", agentName: "Priya" });
    expect(cfg).toMatchObject({ businessName: "Smile Care", agentName: "Priya" });
  });
});

describe("AgentConfig validation", () => {
  const base = TEMPLATES[0]!.config;

  it("rejects references to unknown fields, steps and tools", () => {
    const bad = {
      ...base,
      tools: [],
      greeting: "Hi {{unknown_thing}}",
      workflow: {
        steps: [
          { id: "greet", type: "greeting" },
          { id: "ask", type: "collect_fields", fields: ["nope"] },
          {
            id: "go",
            type: "branch",
            rules: [{ when: [{ field: "budget", op: "gt", value: 1 }], goto: "missing" }],
          },
          { id: "act", type: "tool", tool: "leads.create", input: {} },
          { id: "end", type: "end" },
        ],
      },
    };
    const r = AgentConfig.safeParse(bad);
    expect(r.success).toBe(false);
    const messages = r.error!.issues.map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        "Unknown placeholder {{unknown_thing}}",
        'Unknown field "nope"',
        'Unknown step "missing"',
        'Tool "leads.create" is not enabled for this agent',
      ]),
    );
  });

  it("requires the workflow to finish with end or handoff, and handoff to be configured", () => {
    const r = AgentConfig.safeParse({
      ...base,
      workflow: {
        steps: [
          { id: "greet", type: "greeting" },
          { id: "h", type: "handoff" },
          { id: "s", type: "say", text: "Bye" },
        ],
      },
    });
    const messages = r.error!.issues.map((i) => i.message);
    expect(messages).toContain("The last step must be an end or handoff step");
    expect(messages).toContain("Enable human handoff to use a handoff step");
  });

  it("rejects duplicate field keys and select fields without options", () => {
    const r = AgentConfig.safeParse({
      ...base,
      qualificationFields: [
        { key: "a_field", label: "A", question: "Question one?", type: "text" },
        { key: "a_field", label: "B", question: "Question two?", type: "select", options: ["only"] },
      ],
      workflow: {
        steps: [
          { id: "greet", type: "greeting" },
          { id: "end", type: "end" },
        ],
      },
    });
    const messages = r.error!.issues.map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining(['Duplicate field key "a_field"', "Choice fields need at least 2 options"]),
    );
  });
});
