/**
 * Languages an agent can speak on Twilio, and the voices that speak them. Speech recognition uses
 * the language code (Twilio <Gather language>); text-to-speech uses the voice.
 */
export const AGENT_LANGUAGES = [
  { code: "en-IN", name: "English (India)" },
  { code: "en-GB", name: "English (UK)" },
  { code: "en-US", name: "English (US)" },
  { code: "hi-IN", name: "Hindi" },
  { code: "ar-QA", name: "Arabic (Qatar)" },
  { code: "ar-AE", name: "Arabic (UAE)" },
  { code: "ar-SA", name: "Arabic (Saudi Arabia)" },
  { code: "ar-KW", name: "Arabic (Kuwait)" },
] as const;

export type AgentVoice = { id: string; name: string; languages: string[] };

/** Amazon Polly voices through Twilio <Say>; "ar" matches every Arabic code */
export const AGENT_VOICES: readonly AgentVoice[] = [
  {
    id: "Polly.Kajal-Neural",
    name: "Kajal, female (Indian English and Hindi)",
    languages: ["en-IN", "hi-IN"],
  },
  { id: "Polly.Amy-Neural", name: "Amy, female (British English)", languages: ["en-GB", "en-IN"] },
  { id: "Polly.Brian-Neural", name: "Brian, male (British English)", languages: ["en-GB"] },
  { id: "Polly.Joanna-Neural", name: "Joanna, female (US English)", languages: ["en-US"] },
  { id: "Polly.Matthew-Neural", name: "Matthew, male (US English)", languages: ["en-US"] },
  { id: "Polly.Hala-Neural", name: "Hala, female (Gulf Arabic)", languages: ["ar"] },
  { id: "Polly.Zayd-Neural", name: "Zayd, male (Gulf Arabic)", languages: ["ar"] },
  { id: "Polly.Zeina", name: "Zeina, female (Modern Standard Arabic)", languages: ["ar"] },
];

const isArabicCode = (language: string) => /^ar(?:-|$)/i.test(language);

/** Voices that can speak a language */
export function voicesFor(language: string): AgentVoice[] {
  return AGENT_VOICES.filter((v) =>
    v.languages.some((l) => l === language || (l === "ar" && isArabicCode(language))),
  );
}

/** A voice that speaks the language: the one given if it does, else the language's first voice */
export function voiceForLanguage(language: string, voice?: string): string {
  const fits = voicesFor(language);
  if (voice && (fits.some((v) => v.id === voice) || !AGENT_VOICES.some((v) => v.id === voice))) return voice;
  return fits[0]?.id ?? voice ?? "Polly.Kajal-Neural";
}

/** Arabic wording for every deterministic line (Gulf-friendly, understood across the Gulf) */
export const ARABIC_MESSAGES = {
  didNotHear: "عفواً، ما سمعتك زين.",
  didNotUnderstand: "عفواً، ما فهمت عليك تماماً.",
  safeAnswer: "سؤال حلو. ما عندي هالمعلومة الحين، وبخلي فريقنا يتواصل معك ويأكدها لك.",
  goodbye: "شكراً لاتصالك. مع السلامة!",
  notInterested: "ولا يهمك. شكراً على وقتك، مع السلامة!",
  noResponse: "ما أقدر أسمعك، فبسكّر المكالمة الحين. تقدر تتصل فينا أي وقت. مع السلامة!",
  technicalIssue: "آسف، عندي مشكلة تقنية بسيطة. فريقنا بيتصل فيك قريب.",
  actionFailed: "ما قدرت أكمل الطلب الحين، بس سجلت طلبك وفريقنا بيتابع معك.",
  declined: "ولا يهمك، خلنا نغيّرها.",
} as const;

/** Lines the platform itself says on an agent's calls */
export function systemLines(language: string) {
  return isArabicCode(language)
    ? {
        maxDuration: "وصلنا للحد الأقصى لمدة المكالمة. سجلت كل اللي قلته، وفريقنا بيتابع معك. مع السلامة!",
      }
    : {
        maxDuration:
          "We've reached the time limit for this call. I've noted everything you told me, and our team will follow up. Goodbye.",
      };
}
