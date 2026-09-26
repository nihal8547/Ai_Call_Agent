import { z } from "zod";

/**
 * Tools an agent can be granted. Implementations live in @platform/tools (phase P9);
 * the catalogue lives here so configs can be validated anywhere.
 */
export const TOOL_NAMES = [
  "leads.create",
  "appointments.create",
  "calendar.find_slots",
  "calendar.book",
  "calendar.cancel",
  "sheets.append_row",
  "email.send",
  "sms.send",
  "whatsapp.send",
  "webhook.post",
  "crm.create_lead",
  "crm.update_lead",
] as const;
export const ToolName = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolName>;
