import type { AgentConfigInput } from "@platform/shared";

export const hotel: AgentConfigInput = {
  businessName: "Sunrise Residency",
  agentName: "Rhea",
  greeting:
    "Good day, thank you for calling {{business_name}}. I'm {{agent_name}}. I can help with a room reservation.",
  persona: "Gracious hotel front-desk voice. Polite and efficient.",
  businessRules: ["Only quote room rates and offers that appear in the knowledge base."],
  qualificationFields: [
    {
      key: "guest_name",
      label: "Guest name",
      question: "May I have the name for the reservation?",
      type: "name",
    },
    {
      key: "check_in",
      label: "Check-in",
      question: "What date would you like to check in?",
      type: "date",
      validation: { futureOnly: true },
    },
    {
      key: "nights",
      label: "Nights",
      question: "How many nights will you stay?",
      type: "number",
      validation: { min: 1, max: 30 },
    },
    {
      key: "guests",
      label: "Guests",
      question: "How many guests in total?",
      type: "number",
      validation: { min: 1, max: 12 },
    },
    {
      key: "room_type",
      label: "Room type",
      question: "Would you prefer a standard room, a deluxe room or a suite?",
      type: "select",
      options: ["Standard", "Deluxe", "Suite"],
    },
    {
      key: "breakfast",
      label: "Breakfast",
      question: "Shall I include breakfast?",
      type: "boolean",
      required: false,
    },
  ],
  workflow: {
    steps: [
      { id: "greet", type: "greeting" },
      {
        id: "stay",
        type: "collect_fields",
        fields: ["guest_name", "check_in", "nights", "guests", "room_type", "breakfast"],
      },
      {
        id: "reserve",
        type: "confirm_and_act",
        message:
          "A {{room_type}} room for {{guests}} guests, checking in {{check_in}} for {{nights}} nights. Shall I place the reservation request?",
        action: "leads.create",
        input: {},
        successMessage: "Your reservation request is placed. You'll receive a confirmation message shortly.",
        resetOnDecline: ["check_in", "nights", "room_type"],
        onDecline: "stay",
      },
      { id: "close", type: "end", text: "We look forward to welcoming you, {{guest_name}}. Goodbye!" },
    ],
  },
  tools: ["leads.create"],
};
