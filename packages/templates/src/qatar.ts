import { type AgentConfigInput, ARABIC_MESSAGES } from "@platform/shared";

/**
 * Qatar agents that speak Arabic: Gulf-friendly wording (understood across the Gulf), QAR amounts,
 * Sunday–Thursday working week, Asia/Qatar time. Callers may answer in Arabic or English.
 * Voice and speech recognition: Twilio with an Arabic Polly voice and ar-QA recognition.
 */

const ARABIC_VOICE = { voice: "Polly.Hala-Neural" } as const;
/** The lighter model answers Arabic understanding well and in well under a second */
const ARABIC_LLM = { model: "gemini-flash-lite-latest" } as const;

const ARABIC_HANDOFF = {
  message: "بحوّلك لأحد من فريقنا الحين، لحظة من فضلك.",
  unavailableMessage: "فريقنا مو متوفر الحين. سجلت بياناتك وبيتصل فيك أحد قريب.",
} as const;

/** Sunday–Thursday, and a short Saturday; Friday closed (a fresh copy per template) */
const qatarWeek = () => ({
  timezone: "Asia/Qatar",
  days: {
    sun: [{ start: "08:00", end: "20:00" }],
    mon: [{ start: "08:00", end: "20:00" }],
    tue: [{ start: "08:00", end: "20:00" }],
    wed: [{ start: "08:00", end: "20:00" }],
    thu: [{ start: "08:00", end: "20:00" }],
    sat: [{ start: "10:00", end: "14:00" }],
  },
});

export const qatarRealEstateArabic: AgentConfigInput = {
  businessName: "الدوحة للعقارات",
  agentName: "نورة",
  language: "ar-QA",
  voice: ARABIC_VOICE,
  llm: ARABIC_LLM,
  greeting: "هلا وسهلا، معك {{agent_name}} من {{business_name}}. شكراً لاتصالك!",
  persona: "مستشارة عقارية ودودة وخبيرة. جمل قصيرة وواضحة، بدون إلحاح.",
  instructions:
    "Qualify the caller for buying property in Qatar and offer a viewing. Speak Gulf-friendly Arabic. Answer questions only from the knowledge base.",
  businessRules: [
    "Never quote prices, availability or offers that are not in the knowledge base.",
    "Do not give legal or financing advice; offer to connect the caller with an advisor instead.",
  ],
  qualificationFields: [
    { key: "customer_name", label: "الاسم", question: "ممكن أعرف اسمك الكريم؟", type: "name" },
    {
      key: "property_type",
      label: "نوع العقار",
      question: "وش نوع العقار اللي تدور عليه: شقة، فيلا، تاون هاوس، ولا تجاري؟",
      type: "select",
      options: ["شقة", "فيلا", "تاون هاوس", "تجاري"],
    },
    {
      key: "budget",
      label: "الميزانية",
      question: "كم الميزانية اللي في بالك تقريباً؟",
      type: "currency",
      currency: "QAR",
      validation: { min: 100000, max: 500000000 },
      reaskPrompts: ["تقريباً كم ناوي تصرف؟ مثلاً مليون ونص، أو ثلاث ملايين ريال."],
      confirmBack: true,
    },
    {
      key: "timeline",
      label: "موعد الشراء",
      question: "متى ناوي تشتري: فوراً، خلال 3 شهور، من 3 إلى 6 شهور، ولا بس تستكشف؟",
      type: "select",
      options: ["فوراً", "خلال 3 شهور", "من 3 إلى 6 شهور", "أستكشف فقط"],
    },
    {
      key: "preferred_area",
      label: "المنطقة",
      question: "أي منطقة تفضّل؟",
      type: "text",
      hints: [
        "لوسيل",
        "اللؤلؤة",
        "الخليج الغربي",
        "الوكرة",
        "الدفنة",
        "مشيرب",
        "Lusail",
        "The Pearl",
        "West Bay",
      ],
    },
    {
      key: "financing",
      label: "طريقة الدفع",
      question: "بتشتري كاش، ولا بتمويل بنكي، ولا تحتاج مساعدة في التمويل؟",
      type: "select",
      options: ["كاش", "تمويل بنكي", "أحتاج مساعدة"],
    },
    {
      key: "visit_date",
      label: "يوم المعاينة",
      question: "أي يوم يناسبك للمعاينة؟",
      type: "date",
      validation: { futureOnly: true },
    },
    { key: "visit_time", label: "وقت المعاينة", question: "وأي ساعة تناسبك؟", type: "time" },
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
        rules: [{ when: [{ field: "timeline", op: "eq", value: "أستكشف فقط" }], goto: "share_details" }],
      },
      { id: "visit", type: "collect_fields", fields: ["visit_date", "visit_time"] },
      {
        id: "book_visit",
        type: "confirm_and_act",
        message: "أحجز لك المعاينة يوم {{visit_date}} الساعة {{visit_time}}؟",
        action: "appointments.create",
        input: { title: "معاينة: {{customer_name}}", date: "{{visit_date}}", time: "{{visit_time}}" },
        successMessage: "تم! حجزت لك المعاينة يوم {{visit_date}} الساعة {{visit_time}}.",
        resetOnDecline: ["visit_date", "visit_time"],
        onDecline: "visit",
      },
      { id: "save_lead", type: "tool", tool: "leads.create", background: true, input: {} },
      {
        id: "close_booked",
        type: "end",
        text: "مستشارنا بيتصل فيك قبل المعاينة. شكراً {{customer_name}}، يومك سعيد!",
      },
      {
        id: "share_details",
        type: "say",
        text: "ولا يهمك يا {{customer_name}}. بخلي فريقنا يرسل لك تفاصيل المشاريع في {{preferred_area}}.",
      },
      { id: "save_explorer", type: "tool", tool: "leads.create", background: true, input: {} },
      { id: "close", type: "end" },
    ],
  },
  tools: ["leads.create", "appointments.create"],
  handoff: { ...ARABIC_HANDOFF },
  workingHours: {
    ...qatarWeek(),
    offHours: "normal",
    offHoursMessage: "المكتب مسكّر الحين، بس أقدر آخذ بياناتك والفريق بيتصل فيك.",
  },
  appointment: { durationMinutes: 60, slotsToOffer: 2 },
  messages: { ...ARABIC_MESSAGES },
};

export const qatarClinicArabic: AgentConfigInput = {
  businessName: "عيادة الابتسامة لطب الأسنان",
  agentName: "مريم",
  language: "ar-QA",
  voice: ARABIC_VOICE,
  llm: ARABIC_LLM,
  greeting: "أهلاً، وصلت {{business_name}}. معك {{agent_name}}، وأقدر أساعدك تحجز موعد.",
  persona: "موظفة استقبال هادئة ومهتمة. مطمئنة ومختصرة.",
  instructions:
    "Book appointments and answer questions about services, timings and policies from the knowledge base. Speak Gulf-friendly Arabic.",
  businessRules: [
    "Never give medical advice or diagnoses.",
    "For emergencies, transfer the caller to the front desk immediately.",
  ],
  qualificationFields: [
    { key: "patient_name", label: "اسم المراجع", question: "ممكن اسم المراجع؟", type: "name" },
    {
      key: "service_required",
      label: "الخدمة",
      question: "وش الخدمة اللي تحتاجها: استشارة عامة، تنظيف، علاج عصب، زراعة، تبييض، ولا تقويم؟",
      type: "select",
      options: [
        "استشارة عامة",
        "تنظيف الأسنان",
        "علاج العصب",
        "زراعة الأسنان",
        "تبييض الأسنان",
        "تقويم الأسنان",
      ],
    },
    {
      key: "urgency",
      label: "الأولوية",
      question: "هل الحالة طارئة، ولا تبي موعد خلال أسبوع، ولا وقتك مرن؟",
      type: "select",
      options: ["طوارئ", "خلال أسبوع", "مرن"],
    },
    {
      key: "preferred_date",
      label: "اليوم",
      question: "أي يوم يناسبك تجي؟",
      type: "date",
      validation: { futureOnly: true },
    },
    { key: "preferred_time", label: "الوقت", question: "وأي وقت يناسبك؟", type: "time" },
    {
      key: "phone",
      label: "رقم الجوال",
      question: "وش أفضل رقم جوال نتواصل معك عليه؟",
      type: "phone",
      required: false,
    },
  ],
  workflow: {
    steps: [
      { id: "greet", type: "greeting" },
      { id: "intake", type: "collect_fields", fields: ["patient_name", "service_required", "urgency"] },
      {
        id: "triage",
        type: "branch",
        rules: [{ when: [{ field: "urgency", op: "eq", value: "طوارئ" }], goto: "emergency" }],
      },
      { id: "schedule", type: "collect_fields", fields: ["preferred_date", "preferred_time"] },
      {
        id: "book",
        type: "confirm_and_act",
        message:
          "أقدر أحجز {{service_required}} لـ{{patient_name}} يوم {{preferred_date}} الساعة {{preferred_time}}. أأكد الحجز؟",
        action: "appointments.create",
        input: {
          title: "{{service_required}}: {{patient_name}}",
          date: "{{preferred_date}}",
          time: "{{preferred_time}}",
        },
        successMessage: "تم تأكيد موعدك يوم {{preferred_date}} الساعة {{preferred_time}}.",
        resetOnDecline: ["preferred_date", "preferred_time"],
        onDecline: "schedule",
      },
      { id: "contact", type: "collect_fields", fields: ["phone"] },
      { id: "save_lead", type: "tool", tool: "leads.create", background: true, input: {} },
      { id: "close", type: "end", text: "يا ليت تحضر قبل الموعد بعشر دقايق. سلامتك يا {{patient_name}}!" },
      { id: "emergency", type: "handoff", reason: "Emergency" },
    ],
  },
  tools: ["leads.create", "appointments.create"],
  handoff: {
    enabled: true,
    phoneNumber: "+97444000099",
    message: "بحوّلك لمكتب الاستقبال الحين، لحظة من فضلك.",
    unavailableMessage: ARABIC_HANDOFF.unavailableMessage,
  },
  workingHours: {
    ...qatarWeek(),
    offHours: "take_message",
    offHoursMessage: "العيادة مسكّرة الحين، بس أقدر آخذ بياناتك والفريق بيتصل فيك.",
  },
  appointment: { durationMinutes: 30 },
  messages: { ...ARABIC_MESSAGES },
};
