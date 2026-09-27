import { AgentConfig, type AgentConfigInput } from "@platform/shared";
import { clinic } from "./clinic";
import { hotel } from "./hotel";
import { qatarClinicArabic, qatarRealEstateArabic } from "./qatar";
import { realEstate } from "./real-estate";
import { restaurant } from "./restaurant";

export type AgentTemplate = {
  key: string;
  name: string;
  industry: string;
  description: string;
  config: AgentConfigInput;
};

export const TEMPLATES: readonly AgentTemplate[] = [
  {
    key: "real-estate-ava",
    name: "Real estate lead qualification",
    industry: "real_estate",
    description: "Qualifies buyers (property type, budget, timeline, area, financing) and books site visits.",
    config: realEstate,
  },
  {
    key: "clinic-reception",
    name: "Clinic reception",
    industry: "healthcare",
    description: "Books appointments, triages urgency and transfers emergencies to the front desk.",
    config: clinic,
  },
  {
    key: "hotel-reservations",
    name: "Hotel reservations",
    industry: "hospitality",
    description: "Takes room reservation requests: dates, guests, room type and breakfast.",
    config: hotel,
  },
  {
    key: "restaurant-booking",
    name: "Restaurant table booking",
    industry: "restaurant",
    description: "Books tables with party size, date, time and occasion.",
    config: restaurant,
  },
  {
    key: "qatar-real-estate-ar",
    name: "Qatar real estate (Arabic)",
    industry: "real_estate",
    description:
      "Arabic-speaking agent for Qatar: property type, budget in QAR, timeline, area (Lusail, The Pearl, West Bay…), financing, viewings.",
    config: qatarRealEstateArabic,
  },
  {
    key: "qatar-clinic-ar",
    name: "Qatar clinic reception (Arabic)",
    industry: "healthcare",
    description:
      "Arabic-speaking dental clinic reception for Qatar: bookings Sunday–Thursday, emergencies to the front desk.",
    config: qatarClinicArabic,
  },
];

export function getTemplate(key: string): AgentTemplate | undefined {
  return TEMPLATES.find((t) => t.key === key);
}

/** A validated config from a template, personalised for the business */
export function instantiateTemplate(
  key: string,
  overrides: { businessName?: string; agentName?: string } = {},
): AgentConfig {
  const template = getTemplate(key);
  if (!template) throw new Error(`Unknown template: ${key}`);
  return AgentConfig.parse({ ...template.config, ...overrides });
}
