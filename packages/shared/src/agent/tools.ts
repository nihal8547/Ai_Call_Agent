import { z } from "zod";

/**
 * Tools an agent can be granted. Implementations live in @platform/tools and the API;
 * the catalogue lives here so configs can be validated (and the UI labelled) anywhere.
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

/** Integration kinds a tenant can connect (mirrors the database enum) */
export const INTEGRATION_TYPES = [
  "GOOGLE_CALENDAR",
  "GOOGLE_SHEETS",
  "EMAIL_SMTP",
  "WEBHOOK",
  "CALCOM",
  "HUBSPOT",
  "ZOHO",
  "SALESFORCE",
  "WHATSAPP",
  "REST_API",
] as const;
export const IntegrationType = z.enum(INTEGRATION_TYPES);
export type IntegrationType = z.infer<typeof IntegrationType>;

export type ToolSpec = {
  label: string;
  description: string;
  /** Integration the tool runs through; null = the platform runs it itself */
  integration: IntegrationType | null;
  /** Implemented in this release (others can be configured in drafts but not published) */
  available: boolean;
  /** Changes something outside the call (never retried blindly) */
  sideEffect: boolean;
};

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  "leads.create": {
    label: "Save lead",
    description: "Saves the caller and their answers as a lead.",
    integration: null,
    available: true,
    sideEffect: true,
  },
  "appointments.create": {
    label: "Book appointment",
    description: "Books into the platform's own appointment book (respects hours and capacity).",
    integration: null,
    available: true,
    sideEffect: true,
  },
  "calendar.find_slots": {
    label: "Find free times (Google Calendar)",
    description: "Reads free times on a day and offers them to the caller.",
    integration: "GOOGLE_CALENDAR",
    available: true,
    sideEffect: false,
  },
  "calendar.book": {
    label: "Book in Google Calendar",
    description: "Creates the event if the time is free; otherwise offers the nearest free times.",
    integration: "GOOGLE_CALENDAR",
    available: true,
    sideEffect: true,
  },
  "calendar.cancel": {
    label: "Cancel booking (Google Calendar)",
    description: "Cancels the caller's next upcoming appointment.",
    integration: "GOOGLE_CALENDAR",
    available: true,
    sideEffect: true,
  },
  "sheets.append_row": {
    label: "Add row to Google Sheet",
    description: "Appends the call's details as a new row.",
    integration: "GOOGLE_SHEETS",
    available: true,
    sideEffect: true,
  },
  "email.send": {
    label: "Send email",
    description: "Sends a summary email through your mail server.",
    integration: "EMAIL_SMTP",
    available: true,
    sideEffect: true,
  },
  "webhook.post": {
    label: "Call a webhook",
    description: "Posts the call's details to your system, signed with HMAC-SHA256.",
    integration: "WEBHOOK",
    available: true,
    sideEffect: true,
  },
  "sms.send": {
    label: "Send SMS",
    description: "Coming soon.",
    integration: null,
    available: false,
    sideEffect: true,
  },
  "whatsapp.send": {
    label: "Send WhatsApp message",
    description: "Coming soon.",
    integration: "WHATSAPP",
    available: false,
    sideEffect: true,
  },
  "crm.create_lead": {
    label: "Create CRM lead",
    description: "Coming soon.",
    integration: "HUBSPOT",
    available: false,
    sideEffect: true,
  },
  "crm.update_lead": {
    label: "Update CRM lead",
    description: "Coming soon.",
    integration: "HUBSPOT",
    available: false,
    sideEffect: true,
  },
};
