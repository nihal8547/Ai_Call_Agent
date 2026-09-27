/**
 * Countries a business can operate from. The country sets the calling code for numbers callers say
 * without one, the currency, and sensible defaults (time zone, voice). Add a row to support another.
 */
export const COUNTRIES = {
  IN: { name: "India", callingCode: "91", currency: "INR", timezone: "Asia/Kolkata", language: "en-IN", voice: "Polly.Kajal-Neural" },
  QA: { name: "Qatar", callingCode: "974", currency: "QAR", timezone: "Asia/Qatar", language: "en-GB", voice: "Polly.Amy-Neural" },
  AE: { name: "United Arab Emirates", callingCode: "971", currency: "AED", timezone: "Asia/Dubai", language: "en-GB", voice: "Polly.Amy-Neural" },
  SA: { name: "Saudi Arabia", callingCode: "966", currency: "SAR", timezone: "Asia/Riyadh", language: "en-GB", voice: "Polly.Amy-Neural" },
  KW: { name: "Kuwait", callingCode: "965", currency: "KWD", timezone: "Asia/Kuwait", language: "en-GB", voice: "Polly.Amy-Neural" },
  OM: { name: "Oman", callingCode: "968", currency: "OMR", timezone: "Asia/Muscat", language: "en-GB", voice: "Polly.Amy-Neural" },
  BH: { name: "Bahrain", callingCode: "973", currency: "BHD", timezone: "Asia/Bahrain", language: "en-GB", voice: "Polly.Amy-Neural" },
  GB: { name: "United Kingdom", callingCode: "44", currency: "GBP", timezone: "Europe/London", language: "en-GB", voice: "Polly.Amy-Neural" },
  US: { name: "United States", callingCode: "1", currency: "USD", timezone: "America/New_York", language: "en-US", voice: "Polly.Joanna-Neural" },
} as const;

export type CountryCode = keyof typeof COUNTRIES;
export const COUNTRY_CODES = Object.keys(COUNTRIES) as CountryCode[];
