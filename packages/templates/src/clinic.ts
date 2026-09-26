import type { AgentConfigInput } from "@platform/shared";

export const clinic: AgentConfigInput = {
  businessName: "XYZ Dental Clinic",
  agentName: "Maya",
  greeting:
    "Hello, you've reached {{business_name}}. I'm {{agent_name}}, and I can help you book an appointment.",
  persona: "Calm, caring clinic receptionist. Reassuring and brief.",
  instructions:
    "Book appointments and answer questions about services, timings and policies from the knowledge base.",
  businessRules: [
    "Never give medical advice or diagnoses.",
    "For emergencies, transfer the caller to the front desk immediately.",
  ],
  qualificationFields: [
    { key: "patient_name", label: "Patient name", question: "May I have the patient's name?", type: "name" },
    {
      key: "service_required",
      label: "Service",
      question:
        "Which service do you need: a general consultation, cleaning, a root canal, implants, whitening or braces?",
      type: "select",
      options: [
        "General consultation",
        "Dental cleaning",
        "Root canal",
        "Dental implants",
        "Teeth whitening",
        "Braces",
      ],
    },
    {
      key: "urgency",
      label: "Urgency",
      question: "Is this an emergency, something within a week, or are you flexible?",
      type: "select",
      options: ["Emergency", "Within a week", "Flexible"],
    },
    {
      key: "preferred_date",
      label: "Preferred date",
      question: "Which day would you like to come in?",
      type: "date",
      validation: { futureOnly: true },
    },
    { key: "preferred_time", label: "Preferred time", question: "What time suits you?", type: "time" },
  ],
  workflow: {
    steps: [
      { id: "greet", type: "greeting" },
      { id: "intake", type: "collect_fields", fields: ["patient_name", "service_required", "urgency"] },
      {
        id: "triage",
        type: "branch",
        rules: [{ when: [{ field: "urgency", op: "eq", value: "Emergency" }], goto: "emergency" }],
      },
      { id: "schedule", type: "collect_fields", fields: ["preferred_date", "preferred_time"] },
      {
        id: "book",
        type: "confirm_and_act",
        message:
          "I can book {{service_required}} for {{patient_name}} on {{preferred_date}} at {{preferred_time}}. Shall I confirm?",
        action: "appointments.create",
        input: {
          title: "{{service_required}}: {{patient_name}}",
          date: "{{preferred_date}}",
          time: "{{preferred_time}}",
        },
        successMessage: "Your appointment is confirmed for {{preferred_date}} at {{preferred_time}}.",
        resetOnDecline: ["preferred_date", "preferred_time"],
        onDecline: "schedule",
      },
      { id: "save_lead", type: "tool", tool: "leads.create", background: true, input: {} },
      { id: "close", type: "end", text: "Please arrive ten minutes early. Take care, {{patient_name}}!" },
      { id: "emergency", type: "handoff", reason: "Emergency" },
    ],
  },
  tools: ["leads.create", "appointments.create"],
  handoff: {
    enabled: true,
    phoneNumber: "+911140000099",
    message: "I'm connecting you to our front desk right away. Please hold.",
  },
  workingHours: {
    timezone: "Asia/Kolkata",
    days: {
      mon: [{ start: "09:00", end: "19:00" }],
      tue: [{ start: "09:00", end: "19:00" }],
      wed: [{ start: "09:00", end: "19:00" }],
      thu: [{ start: "09:00", end: "19:00" }],
      fri: [{ start: "09:00", end: "19:00" }],
      sat: [{ start: "10:00", end: "14:00" }],
    },
    offHours: "take_message",
  },
  appointment: { durationMinutes: 30 },
};
