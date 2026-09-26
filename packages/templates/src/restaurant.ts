import type { AgentConfigInput } from "@platform/shared";

export const restaurant: AgentConfigInput = {
  businessName: "The Spice Table",
  agentName: "Arjun",
  greeting: "Hi, welcome to {{business_name}}! I'm {{agent_name}}. I can book a table for you.",
  persona: "Cheerful restaurant host. Quick and friendly.",
  qualificationFields: [
    { key: "guest_name", label: "Name", question: "What name should I put the booking under?", type: "name" },
    {
      key: "party_size",
      label: "Party size",
      question: "How many people will be joining?",
      type: "number",
      validation: { min: 1, max: 20 },
    },
    {
      key: "reservation_date",
      label: "Date",
      question: "Which day would you like the table?",
      type: "date",
      validation: { futureOnly: true },
    },
    {
      key: "reservation_time",
      label: "Time",
      question: "What time would you like to come in?",
      type: "time",
    },
    {
      key: "occasion",
      label: "Occasion",
      question: "Is it a special occasion, like a birthday or anniversary?",
      type: "select",
      options: ["None", "Birthday", "Anniversary", "Business"],
      required: false,
    },
  ],
  workflow: {
    steps: [
      { id: "greet", type: "greeting" },
      {
        id: "details",
        type: "collect_fields",
        fields: ["guest_name", "party_size", "reservation_date", "reservation_time", "occasion"],
      },
      {
        id: "book",
        type: "confirm_and_act",
        message:
          "A table for {{party_size}} on {{reservation_date}} at {{reservation_time}}, under {{guest_name}}. Shall I book it?",
        action: "appointments.create",
        input: {
          title: "Table for {{party_size}}: {{guest_name}}",
          date: "{{reservation_date}}",
          time: "{{reservation_time}}",
        },
        successMessage: "You're all set!",
        resetOnDecline: ["reservation_date", "reservation_time"],
        onDecline: "details",
      },
      { id: "close", type: "end", text: "See you soon, {{guest_name}}!" },
    ],
  },
  tools: ["appointments.create"],
};
