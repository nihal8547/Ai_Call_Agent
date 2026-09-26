/** Everything time- or tenant-dependent the pure engine needs, passed in explicitly */
export type EngineContext = {
  now: Date;
  /** Business time zone, used for "today", "tomorrow" and working hours */
  timezone: string;
  /** Default country calling code for phone numbers without one (e.g. "91") */
  defaultCountryCode?: string;
  callerNumber?: string;
};
