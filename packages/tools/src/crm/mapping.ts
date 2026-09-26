import type { CrmProperty, CrmRecord } from "./types";

/** What an answer or lead detail can be written to */
export type MappableSource = {
  key: string;
  label: string;
  /** Qualification field type, or the built-in detail's type */
  type: string;
  options?: string[];
};

/** Lead details that are not qualification answers but are often wanted in a CRM */
export const BUILTIN_CRM_SOURCES: MappableSource[] = [
  { key: "@summary", label: "Call summary", type: "text" },
  { key: "@status", label: "Lead status", type: "text" },
  { key: "@agent", label: "Agent name", type: "text" },
  { key: "@call_date", label: "Call date", type: "date" },
];

const COMPATIBLE: Record<string, CrmProperty["type"][]> = {
  text: ["string"],
  name: ["string"],
  time: ["string"],
  number: ["number", "string"],
  currency: ["number", "string"],
  select: ["enum", "string"],
  multiselect: ["multienum", "string"],
  boolean: ["bool", "string"],
  date: ["date", "datetime", "string"],
  phone: ["phone", "string"],
  email: ["email", "string"],
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const optionFor = (p: CrmProperty, v: string) => p.options?.find((o) => same(o.value, v) || same(o.label, v));

/**
 * Check a mapping before it is saved: every target exists and accepts the answer's type, and
 * every choice of a select field has a matching CRM option. Returns problems keyed by source.
 */
export function validateCrmMapping(
  mapping: Record<string, string>,
  sources: MappableSource[],
  properties: CrmProperty[],
): { source: string; message: string }[] {
  const problems: { source: string; message: string }[] = [];
  const byKey = new Map(sources.map((s) => [s.key, s]));
  const props = new Map(properties.map((p) => [p.name, p]));
  const used = new Map<string, string>();
  for (const [key, target] of Object.entries(mapping)) {
    const source = byKey.get(key);
    if (!source) {
      problems.push({ source: key, message: "No agent asks for this any more" });
      continue;
    }
    const prop = props.get(target);
    if (!prop) {
      problems.push({ source: key, message: `The CRM has no writable field "${target}"` });
      continue;
    }
    const other = used.get(target);
    if (other) {
      problems.push({
        source: key,
        message: `"${prop.label}" is already filled from ${byKey.get(other)?.label ?? other}`,
      });
      continue;
    }
    used.set(target, key);
    const allowed = COMPATIBLE[source.type] ?? ["string"];
    if (!allowed.includes(prop.type)) {
      problems.push({
        source: key,
        message: `"${prop.label}" is a ${describe(prop.type)} field; ${source.label} is ${describe(source.type)}`,
      });
      continue;
    }
    if ((prop.type === "enum" || prop.type === "multienum") && source.options?.length) {
      const missing = source.options.filter((o) => !optionFor(prop, o));
      if (missing.length)
        problems.push({ source: key, message: `"${prop.label}" has no option for: ${missing.join(", ")}` });
    }
  }
  return problems;
}

function describe(type: string): string {
  const words: Record<string, string> = {
    string: "text",
    enum: "dropdown",
    multienum: "multiple-choice",
    bool: "yes/no",
    boolean: "yes/no",
    select: "a single choice",
    multiselect: "several choices",
    datetime: "date and time",
  };
  return words[type] ?? type;
}

export type CrmLead = {
  customerName: string | null;
  phone: string | null;
  email: string | null;
  data: Record<string, unknown>;
  summary: string | null;
  status: string | null;
  agent: string | null;
  callDate: Date | null;
};

/**
 * The lead as the CRM should receive it. Values that can't be written (a choice with no matching
 * option, text in a number field) are left out and reported, rather than failing the whole sync.
 */
export function buildCrmRecord(
  lead: CrmLead,
  mapping: Record<string, string>,
  properties: CrmProperty[],
): { record: CrmRecord; skipped: string[] } {
  const props = new Map(properties.map((p) => [p.name, p]));
  const [first, ...rest] = (lead.customerName ?? "").trim().split(/\s+/).filter(Boolean);
  const record: CrmRecord = {
    firstName: first ?? null,
    lastName: rest.length ? rest.join(" ") : null,
    phone: lead.phone,
    email: lead.email,
    properties: {},
  };
  const skipped: string[] = [];
  const builtin: Record<string, unknown> = {
    "@summary": lead.summary,
    "@status": lead.status,
    "@agent": lead.agent,
    "@call_date": lead.callDate?.toISOString().slice(0, 10) ?? null,
  };
  for (const [key, target] of Object.entries(mapping)) {
    const prop = props.get(target);
    const raw = key.startsWith("@") ? builtin[key] : lead.data[key];
    if (!prop || raw === undefined || raw === null || raw === "") continue;
    const value = convert(raw, prop);
    if (value === undefined) skipped.push(`${key} → ${prop.label}`);
    else record.properties[target] = value;
  }
  return { record, skipped };
}

function convert(raw: unknown, prop: CrmProperty): string | number | boolean | string[] | undefined {
  const text = (v: unknown) =>
    Array.isArray(v) ? v.map(String).join(", ") : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);
  switch (prop.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[,\s]/g, ""));
      return Number.isFinite(n) ? n : undefined;
    }
    case "bool":
      return typeof raw === "boolean" ? raw : undefined;
    case "date":
    case "datetime":
      return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : undefined;
    case "enum": {
      const o = optionFor(prop, text(raw));
      return o?.value;
    }
    case "multienum": {
      const values = (Array.isArray(raw) ? raw : [raw]).map((v) => optionFor(prop, String(v))?.value);
      return values.every(Boolean) ? (values as string[]) : undefined;
    }
    default:
      return text(raw).slice(0, 5000);
  }
}
