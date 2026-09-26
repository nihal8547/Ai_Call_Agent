import type { AgentConfigInput } from "@platform/shared";

/** "Ava" — the playbook's real estate lead-qualification agent, expressed purely as configuration */
export const realEstate: AgentConfigInput = {
  businessName: "ABC Real Estate",
  agentName: "Ava",
  greeting: "Hi, this is {{agent_name}} from {{business_name}}. Thanks for calling about our properties!",
  persona: "Friendly, knowledgeable property advisor. Short, clear sentences. Never pushy.",
  instructions:
    "Qualify the caller for a property purchase and offer a site visit. Answer questions only from the knowledge base.",
  businessRules: [
    "Never quote prices, availability or offers that are not in the knowledge base.",
    "Do not give legal or loan advice; offer to connect the caller with an advisor instead.",
  ],
  qualificationFields: [
    { key: "customer_name", label: "Name", question: "May I know your name, please?", type: "name" },
    {
      key: "property_type",
      label: "Property type",
      question:
        "What kind of property are you looking for: an apartment, a villa, a plot or a commercial space?",
      type: "select",
      options: ["Apartment", "Villa", "Plot", "Commercial"],
    },
    {
      key: "budget",
      label: "Budget",
      question: "What budget do you have in mind?",
      type: "currency",
      currency: "INR",
      validation: { min: 500000, max: 1000000000 },
      reaskPrompts: ["Roughly how much are you planning to spend? For example, 80 lakh or 1.2 crore."],
      confirmBack: true,
    },
    {
      key: "timeline",
      label: "Timeline",
      question:
        "When are you planning to buy: immediately, within 3 months, in 3 to 6 months, or just exploring?",
      type: "select",
      options: ["Immediately", "Within 3 months", "3 to 6 months", "Just exploring"],
    },
    {
      key: "preferred_area",
      label: "Preferred area",
      question: "Which areas or neighbourhoods do you prefer?",
      type: "text",
      hints: ["Baner", "Wakad", "Hinjewadi", "Kharadi", "Balewadi", "Aundh"],
    },
    {
      key: "financing",
      label: "Financing",
      question: "Will you be buying with a bank loan, your own funds, or would you like help with financing?",
      type: "select",
      options: ["Bank loan", "Own funds", "Need assistance"],
    },
    {
      key: "visit_date",
      label: "Site visit date",
      question: "Which day would suit you for a site visit?",
      type: "date",
      validation: { futureOnly: true },
    },
    { key: "visit_time", label: "Site visit time", question: "And what time works best?", type: "time" },
  ],
  workflow: {
    steps: [
      { id: "greet", type: "greeting" },
      {
        id: "profile",
        type: "collect_fields",
        fields: ["customer_name", "property_type", "budget", "timeline", "preferred_area", "financing"],
      },
      {
        id: "route",
        type: "branch",
        rules: [{ when: [{ field: "timeline", op: "eq", value: "Just exploring" }], goto: "share_details" }],
      },
      { id: "visit", type: "collect_fields", fields: ["visit_date", "visit_time"] },
      {
        id: "book_visit",
        type: "confirm_and_act",
        message: "Shall I book your site visit on {{visit_date}} at {{visit_time}}?",
        action: "appointments.create",
        input: { title: "Site visit: {{customer_name}}", date: "{{visit_date}}", time: "{{visit_time}}" },
        successMessage: "Done! Your site visit is booked for {{visit_date}} at {{visit_time}}.",
        resetOnDecline: ["visit_date", "visit_time"],
        onDecline: "visit",
      },
      { id: "save_lead", type: "tool", tool: "leads.create", background: true, input: {} },
      {
        id: "close_booked",
        type: "end",
        text: "Our advisor will call you before the visit. Thank you, {{customer_name}}, and have a great day!",
      },
      {
        id: "share_details",
        type: "say",
        text: "No problem, {{customer_name}}. I'll have our team share project details in {{preferred_area}} with you.",
      },
      { id: "save_explorer", type: "tool", tool: "leads.create", background: true, input: {} },
      { id: "close", type: "end" },
    ],
  },
  tools: ["leads.create", "appointments.create"],
  appointment: { durationMinutes: 60, slotsToOffer: 2 },
};
