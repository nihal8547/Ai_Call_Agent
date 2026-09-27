import { z } from "zod";
import { E164 } from "../tenancy/defaults";
import { QualificationField } from "./fields";
import { ToolName } from "./tools";
import { Template, type WorkflowStep, WorkflowDefinition } from "./workflow";

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM (24h)");
const Day = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type Day = z.infer<typeof Day>;

export const WorkingHours = z
  .object({
    timezone: z.string().min(1).max(64),
    /** Days missing from the map are closed */
    days: z.partialRecord(Day, z.array(z.object({ start: HHMM, end: HHMM })).max(4)).default({}),
    holidays: z.array(z.iso.date()).max(100).default([]),
    /** Special periods (Ramadan, Eid …): their hours replace the weekly ones on those dates; no hours = closed */
    dateRangeOverrides: z
      .array(
        z.object({
          name: z.string().min(1).max(80),
          startDate: z.iso.date(),
          endDate: z.iso.date(),
          hours: z.array(z.object({ start: HHMM, end: HHMM })).max(4),
        }),
      )
      .max(20)
      .default([]),
    /** What to do outside working hours */
    offHours: z.enum(["normal", "take_message", "closed_message"]).default("normal"),
    offHoursMessage: Template.default(
      "Our office is closed right now, but I can take your details and the team will call you back.",
    ),
  })
  .superRefine((w, ctx) => {
    for (const [day, ranges] of Object.entries(w.days)) {
      ranges?.forEach((r, i) => {
        if (r.start >= r.end)
          ctx.addIssue({ code: "custom", path: ["days", day, i, "end"], message: "end must be after start" });
      });
    }
    w.dateRangeOverrides.forEach((override, i) => {
      if (override.startDate > override.endDate) {
        ctx.addIssue({
          code: "custom",
          path: ["dateRangeOverrides", i, "endDate"],
          message: "The end date must be on or after the start date",
        });
      }
      override.hours.forEach((r, j) => {
        if (r.start >= r.end) {
          ctx.addIssue({
            code: "custom",
            path: ["dateRangeOverrides", i, "hours", j, "end"],
            message: "end must be after start",
          });
        }
      });
    });
  });
export type WorkingHours = z.infer<typeof WorkingHours>;

export const EscalationRules = z.object({
  /** Transfer when the caller asks for a person */
  onWantsHuman: z.enum(["handoff", "take_message"]).default("handoff"),
  /** Re-asks per field before giving up on it */
  maxReasksPerField: z.number().int().min(0).max(5).default(2),
  /** What to do when a required field cannot be captured */
  onFieldFailure: z.enum(["skip", "handoff", "end"]).default("skip"),
  maxSilentTurns: z.number().int().min(1).max(10).default(3),
  /** Consecutive LLM failures before the call runs on deterministic prompts only */
  maxLlmFailures: z.number().int().min(1).max(10).default(2),
});

export const HandoffConfig = z.object({
  enabled: z.boolean().default(false),
  /** Where to transfer (E.164 number); required when enabled */
  phoneNumber: E164.optional(),
  message: Template.default("Let me connect you with a member of our team. Please hold."),
  unavailableMessage: Template.default(
    "Our team is not available right now. I have noted your details and someone will call you back.",
  ),
  /** Staff emailed a summary when a transfer is not answered (sent through the email integration) */
  notifyEmails: z.array(z.email().max(254)).max(5).default([]),
});

export const KnowledgeConfig = z.object({
  collectionIds: z.array(z.uuid()).max(20).default([]),
  topK: z.number().int().min(1).max(10).default(4),
  minScore: z.number().min(0).max(1).default(0.55),
  /** Never answer business-specific questions from the model's general knowledge */
  allowGeneralKnowledge: z.literal(false).default(false),
});

export const AppointmentConfig = z.object({
  durationMinutes: z.number().int().min(5).max(480).default(30),
  bufferMinutes: z.number().int().min(0).max(240).default(0),
  leadTimeMinutes: z.number().int().min(0).max(10080).default(60),
  maxDaysAhead: z.number().int().min(1).max(365).default(30),
  slotsToOffer: z.number().int().min(1).max(5).default(2),
  /** Bookings allowed at the same time (tables, chairs, rooms); 1 = no overlaps */
  capacity: z.number().int().min(1).max(500).default(1),
  /** Start times are offered on this grid (e.g. every 30 minutes) */
  slotStepMinutes: z.number().int().min(5).max(240).default(30),
});

export const LLMConfig = z.object({
  provider: z.enum(["gemini", "openai", "anthropic"]).default("gemini"),
  model: z.string().min(1).max(80).default("gemini-flash-latest"),
  temperature: z.number().min(0).max(1).default(0.3),
  timeoutMs: z.number().int().min(500).max(15000).default(2500),
  /** Let the LLM rephrase the deterministic reply so it sounds natural (facts are verified afterwards) */
  rephrase: z.boolean().default(true),
});

export const CallLimits = z.object({
  maxDurationSeconds: z.number().int().min(60).max(3600).default(600),
  maxTurns: z.number().int().min(4).max(200).default(40),
  maxTokens: z.number().int().min(1000).max(500_000).default(60_000),
});

export const VoiceConfig = z.object({
  provider: z.literal("twilio").default("twilio"),
  /** Provider voice id, e.g. "Polly.Kajal-Neural" */
  voice: z.string().min(1).max(80).default("Polly.Kajal-Neural"),
  speed: z.number().min(0.5).max(2).default(1),
  /**
   * classic: turn by turn (Twilio <Gather>, the caller waits for each reply to finish);
   * streaming: Twilio ConversationRelay, faster turns and the caller can interrupt
   */
  mode: z.enum(["classic", "streaming"]).default("classic"),
  /** Streaming only: speech recognition (auto = Google for Arabic, Deepgram otherwise) */
  transcriber: z.enum(["auto", "deepgram", "google"]).default("auto"),
});

/** Deterministic lines used by the fallback path; every one is configurable per agent */
export const FallbackMessages = z.object({
  didNotHear: Template.default("Sorry, I didn't catch that."),
  didNotUnderstand: Template.default("Sorry, I didn't quite get that."),
  safeAnswer: Template.default(
    "That's a good question. I don't have that detail right now, so I'll have our team confirm it for you.",
  ),
  goodbye: Template.default("Thank you for calling. Goodbye!"),
  notInterested: Template.default("No problem at all. Thank you for your time. Goodbye!"),
  noResponse: Template.default(
    "I'm having trouble hearing you, so I'll end the call now. Please call us back any time. Goodbye!",
  ),
  technicalIssue: Template.default(
    "I'm sorry, I'm having a small technical issue. Our team will call you back shortly.",
  ),
  actionFailed: Template.default(
    "I couldn't complete that just now, but I've noted your request and our team will follow up.",
  ),
  declined: Template.default("No problem, let's change that."),
});

export const AgentConfig = z
  .object({
    businessName: z.string().trim().min(2).max(120),
    agentName: z.string().trim().min(1).max(60),
    language: z.string().min(2).max(10).default("en-IN"),
    voice: VoiceConfig.default(VoiceConfig.parse({})),
    /** First thing the agent says; may use {{agent_name}} and {{business_name}} */
    greeting: Template,
    persona: z
      .string()
      .trim()
      .max(1000)
      .default("Warm, concise and professional. Speaks in short sentences."),
    instructions: z.string().trim().max(4000).default(""),
    businessRules: z.array(z.string().trim().min(3).max(300)).max(30).default([]),
    qualificationFields: z.array(QualificationField).max(30),
    workflow: WorkflowDefinition,
    knowledge: KnowledgeConfig.default(KnowledgeConfig.parse({})),
    tools: z.array(ToolName).max(20).default([]),
    escalation: EscalationRules.default(EscalationRules.parse({})),
    handoff: HandoffConfig.default(HandoffConfig.parse({})),
    workingHours: WorkingHours.optional(),
    appointment: AppointmentConfig.optional(),
    llm: LLMConfig.default(LLMConfig.parse({})),
    limits: CallLimits.default(CallLimits.parse({})),
    messages: FallbackMessages.default(FallbackMessages.parse({})),
  })
  .superRefine((c, ctx) => {
    const fieldKeys = new Set<string>();
    c.qualificationFields.forEach((f, i) => {
      if (fieldKeys.has(f.key))
        ctx.addIssue({
          code: "custom",
          path: ["qualificationFields", i, "key"],
          message: `Duplicate field key "${f.key}"`,
        });
      fieldKeys.add(f.key);
    });

    const steps = c.workflow.steps;
    const stepIds = new Set<string>();
    steps.forEach((s, i) => {
      if (stepIds.has(s.id))
        ctx.addIssue({
          code: "custom",
          path: ["workflow", "steps", i, "id"],
          message: `Duplicate step id "${s.id}"`,
        });
      stepIds.add(s.id);
    });

    const at = (i: number, ...rest: (string | number)[]) => ["workflow", "steps", i, ...rest];
    const checkStep = (i: number, id: string | undefined, key: string) => {
      if (id && !stepIds.has(id))
        ctx.addIssue({ code: "custom", path: at(i, key), message: `Unknown step "${id}"` });
    };
    const checkTool = (i: number, tool: string, key: string) => {
      if (!c.tools.includes(tool as ToolName)) {
        ctx.addIssue({
          code: "custom",
          path: at(i, key),
          message: `Tool "${tool}" is not enabled for this agent`,
        });
      }
    };
    const checkTemplate = (path: (string | number)[], text: string | undefined) => {
      for (const ref of templateRefs(text)) {
        if (!fieldKeys.has(ref) && !BUILT_IN_VARS.has(ref)) {
          ctx.addIssue({ code: "custom", path, message: `Unknown placeholder {{${ref}}}` });
        }
      }
    };

    steps.forEach((s: WorkflowStep, i) => {
      switch (s.type) {
        case "collect_fields":
          s.fields.forEach((f, j) => {
            if (!fieldKeys.has(f))
              ctx.addIssue({ code: "custom", path: at(i, "fields", j), message: `Unknown field "${f}"` });
          });
          break;
        case "say":
          checkTemplate(at(i, "text"), s.text);
          break;
        case "tool":
          checkTool(i, s.tool, "tool");
          checkStep(i, s.onError, "onError");
          Object.entries(s.input).forEach(
            ([k, v]) => typeof v === "string" && checkTemplate(at(i, "input", k), v),
          );
          break;
        case "confirm_and_act":
          checkTool(i, s.action, "action");
          checkStep(i, s.onDecline, "onDecline");
          checkStep(i, s.onError, "onError");
          checkTemplate(at(i, "message"), s.message);
          checkTemplate(at(i, "successMessage"), s.successMessage);
          Object.entries(s.input).forEach(
            ([k, v]) => typeof v === "string" && checkTemplate(at(i, "input", k), v),
          );
          s.resetOnDecline.forEach((f, j) => {
            if (!fieldKeys.has(f))
              ctx.addIssue({
                code: "custom",
                path: at(i, "resetOnDecline", j),
                message: `Unknown field "${f}"`,
              });
          });
          break;
        case "branch":
          s.rules.forEach((r, j) => {
            checkStep(i, r.goto, "rules");
            r.when.forEach((cond, k) => {
              if (!fieldKeys.has(cond.field)) {
                ctx.addIssue({
                  code: "custom",
                  path: at(i, "rules", j, "when", k, "field"),
                  message: `Unknown field "${cond.field}"`,
                });
              }
            });
          });
          checkStep(i, s.otherwise, "otherwise");
          break;
        case "end":
          checkTemplate(at(i, "text"), s.text);
          break;
        case "handoff":
          if (!c.handoff.enabled) {
            ctx.addIssue({
              code: "custom",
              path: at(i, "type"),
              message: "Enable human handoff to use a handoff step",
            });
          }
          break;
        case "greeting":
          break;
      }
    });

    const last = steps[steps.length - 1];
    if (last && last.type !== "end" && last.type !== "handoff") {
      ctx.addIssue({
        code: "custom",
        path: ["workflow", "steps", steps.length - 1],
        message: "The last step must be an end or handoff step",
      });
    }
    if (c.handoff.enabled && !c.handoff.phoneNumber) {
      ctx.addIssue({
        code: "custom",
        path: ["handoff", "phoneNumber"],
        message: "Set the number to transfer calls to",
      });
    }
    checkTemplate(["greeting"], c.greeting);
  });
export type AgentConfig = z.infer<typeof AgentConfig>;
export type AgentConfigInput = z.input<typeof AgentConfig>;

/** Placeholders available in every template besides field keys */
export const BUILT_IN_VARS = new Set(["agent_name", "business_name", "caller_number"]);

export function templateRefs(text: string | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)].map((m) => m[1]!);
}
