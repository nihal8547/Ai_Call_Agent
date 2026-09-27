/**
 * SIP addressing. Calls from a business's trunk reach Twilio's SIP domain and our webhook with
 * `To` = "sip:+97444123456@acme-7f3a.sip.twilio.com" and `From` = "sip:+97455123456@203.0.113.5".
 */
export type SipAddress = { user: string; host: string };

export function parseSipUri(value: string): SipAddress | null {
  const m = /^<?sips?:([^@;>]+)@([^;>:]+)/i.exec(value.trim());
  if (!m) return null;
  return { user: decodeURIComponent(m[1]!), host: m[2]!.toLowerCase() };
}

/** "acme-7f3a.sip.twilio.com" (or a regional "….sip.us1.twilio.com") → "acme-7f3a"; other hosts → null */
export function sipDomainLabel(host: string): string | null {
  const m = /^([a-z0-9][a-z0-9-]{0,61}[a-z0-9]?)\.sip(?:\.[a-z0-9-]+)?\.twilio\.com$/.exec(
    host.toLowerCase(),
  );
  return m ? m[1]! : null;
}

/** IPv4 address or CIDR range (a trunk's signalling addresses); private ranges are refused */
export function validTrunkCidr(value: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(value.trim());
  if (!m) return false;
  const o = m.slice(1, 5).map(Number);
  const prefix = m[5] === undefined ? 32 : Number(m[5]);
  if (o.some((x) => x > 255) || prefix < 16 || prefix > 32) return false;
  const [a, b] = o as [number, number, number, number];
  const privateRange =
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a >= 224;
  return !privateRange;
}
