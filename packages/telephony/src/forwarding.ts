/**
 * How a business points its existing line (Ooredoo, Vodafone Qatar, …) at the agent's Twilio
 * number. Mobile lines use the standard GSM call-forwarding codes, which Ooredoo and Vodafone
 * Qatar support; landlines and PBXs are set up by the carrier or the PBX vendor.
 */
export const CARRIERS = {
  ooredoo: { name: "Ooredoo", support: "Ooredoo business care: 111 (from an Ooredoo line)" },
  vodafone_qa: { name: "Vodafone Qatar", support: "Vodafone business care: 111 (from a Vodafone line)" },
  other: { name: "Another carrier", support: "Your carrier's business support" },
} as const;
export type Carrier = keyof typeof CARRIERS;

export const FORWARDING_MODES = ["NO_ANSWER_BUSY_UNREACHABLE", "ALL"] as const;
export type ForwardingMode = (typeof FORWARDING_MODES)[number];

export type ForwardingStep = { label: string; code?: string };

/** The steps to show a business, with the codes filled in */
export function forwardingInstructions(target: string, mode: ForwardingMode, carrier: Carrier) {
  const t = target.replace(/\s/g, "");
  const enable: ForwardingStep[] =
    mode === "ALL"
      ? [{ label: "Forward every call to the agent", code: `**21*${t}#` }]
      : [
          { label: "When nobody answers within 20 seconds", code: `**61*${t}**20#` },
          { label: "When the line is busy", code: `**67*${t}#` },
          { label: "When the phone is off or unreachable", code: `**62*${t}#` },
        ];
  const disable: ForwardingStep[] =
    mode === "ALL"
      ? [{ label: "Stop forwarding every call", code: "##21#" }]
      : [{ label: "Stop all conditional forwarding", code: "##004#" }];
  return {
    target: t,
    mobile: {
      enable,
      disable,
      note: "Dial each code from the business mobile and press call. The phone confirms each one.",
    },
    landline: `For a landline or a PBX, ask ${CARRIERS[carrier].name} (${CARRIERS[carrier].support}) or your PBX vendor to forward ${mode === "ALL" ? "all calls" : "unanswered, busy and unreachable calls"} to ${t}.`,
    costs: `${CARRIERS[carrier].name} may charge for forwarded calls at its rate for calls to ${t}.`,
  };
}
