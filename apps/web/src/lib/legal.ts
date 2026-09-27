import "server-only";
import { connection } from "next/server";

export type LegalLinks = { terms: string | null; privacy: string | null };

const httpUrl = (v: string | undefined) => (v && /^https?:\/\//.test(v) ? v : null);

/** The platform's terms of service and privacy policy (TERMS_URL, PRIVACY_URL), read per request */
export async function legalLinks(): Promise<LegalLinks> {
  await connection();
  return { terms: httpUrl(process.env.TERMS_URL), privacy: httpUrl(process.env.PRIVACY_URL) };
}
