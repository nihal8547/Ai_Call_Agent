import type { AgentConfig } from "@platform/shared";
import type { EngineContext } from "./context";
import { formatFieldValue } from "./fields";

/** Fill {{placeholders}} with speech-formatted values. Unknown or missing values render as "". */
export function renderTemplate(
  template: string,
  config: AgentConfig,
  collected: Record<string, unknown>,
  ctx?: EngineContext,
): string {
  const byKey = new Map(config.qualificationFields.map((f) => [f.key, f]));
  return template
    .replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, key: string) => {
      if (key === "agent_name") return config.agentName;
      if (key === "business_name") return config.businessName;
      if (key === "caller_number") return ctx?.callerNumber ?? "";
      return formatFieldValue(byKey.get(key), collected[key]);
    })
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Tool arguments: {{field}} placeholders resolve to raw (not speech-formatted) values */
export function renderToolInput(
  input: Record<string, string | number | boolean>,
  collected: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v !== "string") {
      out[k] = v;
      continue;
    }
    const whole = v.match(/^\{\{\s*([a-z][a-z0-9_]*)\s*\}\}$/);
    out[k] = whole
      ? (collected[whole[1]!] ?? null)
      : v.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, key: string) => String(collected[key] ?? ""));
  }
  return out;
}
