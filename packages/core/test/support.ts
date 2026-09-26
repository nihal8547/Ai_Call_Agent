import { instantiateTemplate } from "@platform/templates";
import type { AgentConfig } from "@platform/shared";
import {
  type EngineContext,
  handleTurn,
  resumeAfterTool,
  startCall,
  type ToolCall,
  type ToolResult,
  type TurnInput,
  type TurnOutput,
} from "../src";

/** Monday 28 Sep 2026, 11:30 in India — inside clinic hours */
export const ctx: EngineContext = {
  timezone: "Asia/Kolkata",
  now: new Date("2026-09-28T06:00:00Z"),
  defaultCountryCode: "91",
};

export type Line = string | TurnInput;

export type Conversation = {
  outputs: TurnOutput[];
  last: TurnOutput;
  transcript: string[];
  toolCalls: ToolCall[];
};

/**
 * Drive a whole call. Blocking tools succeed unless `toolResult` says otherwise.
 */
export function converse(
  config: AgentConfig,
  lines: Line[],
  opts: { toolResult?: (call: ToolCall) => ToolResult; context?: EngineContext } = {},
): Conversation {
  const context = opts.context ?? ctx;
  const outputs: TurnOutput[] = [];
  const transcript: string[] = [];
  const toolCalls: ToolCall[] = [];

  const settle = (out: TurnOutput): TurnOutput => {
    let o = out;
    outputs.push(o);
    if (o.speech) transcript.push(`AGENT: ${o.speech}`);
    toolCalls.push(...o.backgroundTools);
    while (o.awaitingTool) {
      toolCalls.push(o.awaitingTool);
      const result = opts.toolResult?.(o.awaitingTool) ?? { ok: true, data: { id: "t1" } };
      o = resumeAfterTool(o.session, config, result, context);
      outputs.push(o);
      if (o.speech) transcript.push(`AGENT: ${o.speech}`);
      toolCalls.push(...o.backgroundTools);
    }
    return o;
  };

  let current = settle(startCall(config, context, "call-1"));
  for (const line of lines) {
    const input: TurnInput = typeof line === "string" ? { transcript: line } : line;
    transcript.push(`CALLER: ${input.transcript}`);
    current = settle(handleTurn(current.session, config, input, context));
  }
  return { outputs, last: current, transcript, toolCalls };
}

export const realEstate = () => instantiateTemplate("real-estate-ava");
export const clinic = () => instantiateTemplate("clinic-reception");
export const hotel = () => instantiateTemplate("hotel-reservations");
export const restaurant = () => instantiateTemplate("restaurant-booking");
