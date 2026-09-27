/**
 * The few Twilio REST calls the platform makes: finding and buying numbers, pointing them at our
 * webhooks, and SIP domains for business trunks (Ooredoo SIP-T, Vodafone business SIP, a PBX).
 * Plain fetch, so tests can fake Twilio and nothing else is pulled into the API.
 */
export type TwilioRestConfig = {
  accountSid: string;
  /** API key (SK…) and secret; or the account auth token with the account SID */
  username: string;
  password: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
};

export class TwilioRestError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = "TwilioRestError";
  }
}

export type AvailableNumber = {
  phoneNumber: string;
  friendlyName: string;
  locality: string | null;
  region: string | null;
  isoCountry: string;
  capabilities: { voice: boolean; sms: boolean };
  /** Countries require an address or identity documents before some numbers can be bought */
  addressRequirements: string;
};
export type OwnedNumber = { sid: string; phoneNumber: string; friendlyName: string; voiceUrl: string | null };
export type NumberType = "local" | "mobile" | "toll_free";

const TYPE_PATH: Record<NumberType, string> = { local: "Local", mobile: "Mobile", toll_free: "TollFree" };

export class TwilioRest {
  private readonly f: typeof fetch;
  private readonly base: string;

  constructor(private readonly cfg: TwilioRestConfig) {
    this.f = cfg.fetch ?? fetch;
    this.base = `${cfg.baseUrl ?? "https://api.twilio.com"}/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}`;
  }

  private async call<T>(method: string, path: string, form?: Record<string, string | undefined>): Promise<T> {
    const body = form
      ? new URLSearchParams(Object.entries(form).filter((e): e is [string, string] => e[1] !== undefined))
      : undefined;
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString("base64")}`,
          ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(body ? { body } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new TwilioRestError(0, null, `Could not reach Twilio (${(err as Error).name})`);
    }
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as { message?: string; code?: number };
    if (!res.ok)
      throw new TwilioRestError(res.status, json.code ?? null, `Twilio: ${json.message ?? `HTTP ${res.status}`}`);
    return json as T;
  }

  // ── Numbers ────────────────────────────────────────────────────────────────
  async searchNumbers(q: {
    country: string;
    type: NumberType;
    contains?: string;
    areaCode?: string;
    limit?: number;
  }): Promise<AvailableNumber[]> {
    const params = new URLSearchParams({ VoiceEnabled: "true", PageSize: String(q.limit ?? 20) });
    if (q.contains) params.set("Contains", q.contains);
    if (q.areaCode) params.set("AreaCode", q.areaCode);
    type Raw = {
      phone_number: string;
      friendly_name: string;
      locality: string | null;
      region: string | null;
      iso_country: string;
      capabilities: { voice?: boolean; SMS?: boolean; sms?: boolean };
      address_requirements: string;
    };
    const r = await this.call<{ available_phone_numbers: Raw[] }>(
      "GET",
      `/AvailablePhoneNumbers/${encodeURIComponent(q.country)}/${TYPE_PATH[q.type]}.json?${params}`,
    );
    return r.available_phone_numbers.map((n) => ({
      phoneNumber: n.phone_number,
      friendlyName: n.friendly_name,
      locality: n.locality || null,
      region: n.region || null,
      isoCountry: n.iso_country,
      capabilities: { voice: Boolean(n.capabilities.voice), sms: Boolean(n.capabilities.SMS ?? n.capabilities.sms) },
      addressRequirements: n.address_requirements,
    }));
  }

  /** Buy a number and point its calls at our webhooks in one step */
  async buyNumber(o: {
    phoneNumber: string;
    voiceUrl: string;
    statusCallback: string;
    friendlyName?: string;
    addressSid?: string;
    bundleSid?: string;
  }): Promise<OwnedNumber> {
    const r = await this.call<RawOwned>("POST", "/IncomingPhoneNumbers.json", {
      PhoneNumber: o.phoneNumber,
      VoiceUrl: o.voiceUrl,
      VoiceMethod: "POST",
      StatusCallback: o.statusCallback,
      StatusCallbackMethod: "POST",
      FriendlyName: o.friendlyName,
      AddressSid: o.addressSid,
      BundleSid: o.bundleSid,
    });
    return owned(r);
  }

  /** Numbers already on the account (e.g. bought in the Twilio console) */
  async listNumbers(): Promise<OwnedNumber[]> {
    const r = await this.call<{ incoming_phone_numbers: RawOwned[] }>("GET", "/IncomingPhoneNumbers.json?PageSize=200");
    return r.incoming_phone_numbers.map(owned);
  }

  async configureNumber(sid: string, o: { voiceUrl: string; statusCallback: string }): Promise<OwnedNumber> {
    return owned(
      await this.call<RawOwned>("POST", `/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`, {
        VoiceUrl: o.voiceUrl,
        VoiceMethod: "POST",
        StatusCallback: o.statusCallback,
        StatusCallbackMethod: "POST",
      }),
    );
  }

  async releaseNumber(sid: string): Promise<void> {
    await this.call("DELETE", `/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`);
  }

  // ── SIP domains (business trunks) ───────────────────────────────────────────
  /** A SIP domain whose calls are sent to our voice webhook; returns its SID */
  async createSipDomain(o: { domainName: string; friendlyName: string; voiceUrl: string; statusCallback: string }) {
    const r = await this.call<{ sid: string; domain_name: string }>("POST", "/SIP/Domains.json", {
      DomainName: o.domainName,
      FriendlyName: o.friendlyName.slice(0, 64),
      VoiceUrl: o.voiceUrl,
      VoiceMethod: "POST",
      VoiceStatusCallbackUrl: o.statusCallback,
      VoiceStatusCallbackMethod: "POST",
      SipRegistration: "false",
      Secure: "true",
    });
    return { sid: r.sid, domainName: r.domain_name };
  }

  async deleteSipDomain(sid: string): Promise<void> {
    await this.call("DELETE", `/SIP/Domains/${encodeURIComponent(sid)}.json`);
  }

  /** An IP access control list holding exactly `cidrs`, mapped to the domain for calls */
  async createIpAcl(domainSid: string, friendlyName: string, cidrs: string[]): Promise<string> {
    const acl = await this.call<{ sid: string }>("POST", "/SIP/IpAccessControlLists.json", {
      FriendlyName: friendlyName.slice(0, 64),
    });
    await this.setIpAclAddresses(acl.sid, cidrs);
    await this.call("POST", `/SIP/Domains/${encodeURIComponent(domainSid)}/Auth/Calls/IpAccessControlListMappings.json`, {
      IpAccessControlListSid: acl.sid,
    });
    return acl.sid;
  }

  /** Replace the addresses in an IP access control list */
  async setIpAclAddresses(aclSid: string, cidrs: string[]): Promise<void> {
    const path = `/SIP/IpAccessControlLists/${encodeURIComponent(aclSid)}/IpAddresses`;
    const existing = await this.call<{ ip_addresses: { sid: string }[] }>("GET", `${path}.json?PageSize=200`);
    for (const ip of existing.ip_addresses) await this.call("DELETE", `${path}/${encodeURIComponent(ip.sid)}.json`);
    for (const [i, cidr] of cidrs.entries()) {
      const [ip, prefix] = cidr.split("/");
      await this.call("POST", `${path}.json`, {
        FriendlyName: `range-${i + 1}`,
        IpAddress: ip!,
        CidrPrefixLength: prefix ?? "32",
      });
    }
  }

  async deleteIpAcl(sid: string): Promise<void> {
    await this.call("DELETE", `/SIP/IpAccessControlLists/${encodeURIComponent(sid)}.json`);
  }

  /** A credential list with one username/password, mapped to the domain for calls */
  async createCredentials(domainSid: string, friendlyName: string, username: string, password: string): Promise<string> {
    const list = await this.call<{ sid: string }>("POST", "/SIP/CredentialLists.json", {
      FriendlyName: friendlyName.slice(0, 64),
    });
    await this.call("POST", `/SIP/CredentialLists/${encodeURIComponent(list.sid)}/Credentials.json`, {
      Username: username,
      Password: password,
    });
    await this.call("POST", `/SIP/Domains/${encodeURIComponent(domainSid)}/Auth/Calls/CredentialListMappings.json`, {
      CredentialListSid: list.sid,
    });
    return list.sid;
  }

  async deleteCredentialList(sid: string): Promise<void> {
    await this.call("DELETE", `/SIP/CredentialLists/${encodeURIComponent(sid)}.json`);
  }
}

type RawOwned = { sid: string; phone_number: string; friendly_name: string; voice_url: string | null };
const owned = (r: RawOwned): OwnedNumber => ({
  sid: r.sid,
  phoneNumber: r.phone_number,
  friendlyName: r.friendly_name,
  voiceUrl: r.voice_url || null,
});
