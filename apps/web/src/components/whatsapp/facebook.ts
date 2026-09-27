"use client";

/**
 * WhatsApp Embedded Signup with the Facebook JS SDK: Meta's popup lets the owner pick or create a
 * WhatsApp Business account and verify the number, then returns a one-time code (to the SDK
 * callback) and the account and number ids (in a message from facebook.com).
 */

type FacebookSdk = {
  init(o: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(
    cb: (r: { authResponse?: { code?: string } | null; status?: string }) => void,
    o: Record<string, unknown>,
  ): void;
};

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

let loading: Promise<FacebookSdk> | null = null;

function loadSdk(appId: string, version: string): Promise<FacebookSdk> {
  if (window.FB) return Promise.resolve(window.FB);
  loading ??= new Promise<FacebookSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB!);
    };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    s.async = true;
    s.crossOrigin = "anonymous";
    s.onerror = () => {
      loading = null;
      reject(new Error("Couldn't load Facebook sign-in. Check your connection or ad blocker and try again."));
    };
    document.body.appendChild(s);
  });
  return loading;
}

export type SignupResult = { code: string; wabaId: string; phoneNumberId: string; onBusinessApp: boolean };

const FACEBOOK_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?facebook\.com$/;

export async function embeddedSignup(o: {
  appId: string;
  configId: string;
  graphVersion: string;
  /** The number stays on the WhatsApp Business app (Meta's coexistence onboarding) */
  onBusinessApp?: boolean;
}): Promise<SignupResult> {
  const fb = await loadSdk(o.appId, o.graphVersion);
  const session: {
    wabaId?: string;
    phoneNumberId?: string;
    error?: string;
    cancelledAt?: string;
    onlyAccount?: boolean;
    businessApp?: boolean;
  } = {};
  const onMessage = (ev: MessageEvent) => {
    if (!FACEBOOK_ORIGIN.test(ev.origin)) return;
    let data: { type?: string; event?: string; data?: Record<string, string> };
    try {
      data = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
    } catch {
      return;
    }
    if (data?.type !== "WA_EMBEDDED_SIGNUP") return;
    if (data.event === "FINISH_ONLY_WABA") session.onlyAccount = true;
    else if (data.event?.startsWith("FINISH")) {
      session.wabaId = data.data?.waba_id;
      session.phoneNumberId = data.data?.phone_number_id;
      session.businessApp = data.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING";
    } else if (data.event === "CANCEL") session.cancelledAt = data.data?.current_step ?? "unknown";
    else if (data.event === "ERROR") session.error = data.data?.error_message ?? "Facebook reported an error";
  };
  window.addEventListener("message", onMessage);
  try {
    const code = await new Promise<string>((resolve, reject) => {
      fb.login(
        (r) => {
          const c = r.authResponse?.code;
          if (c) resolve(c);
          else reject(new Error(session.error ?? "Facebook sign-in was closed before it finished."));
        },
        {
          config_id: o.configId,
          response_type: "code",
          override_default_response_type: true,
          extras: {
            setup: {},
            featureType: o.onBusinessApp ? "whatsapp_business_app_onboarding" : "",
            sessionInfoVersion: "3",
          },
        },
      );
    });
    // The account and number ids arrive in a separate message, usually just before or after the code
    for (let i = 0; i < 50 && !session.phoneNumberId; i++) await new Promise((r) => setTimeout(r, 100));
    if (session.onlyAccount && !session.phoneNumberId)
      throw new Error(
        "The WhatsApp Business account was set up, but no phone number was added. Continue with Facebook again and add your number.",
      );
    if (!session.wabaId || !session.phoneNumberId)
      throw new Error("Facebook didn't say which WhatsApp number was chosen. Please try again.");
    return {
      code,
      wabaId: session.wabaId,
      phoneNumberId: session.phoneNumberId,
      onBusinessApp: Boolean(session.businessApp ?? o.onBusinessApp),
    };
  } finally {
    window.removeEventListener("message", onMessage);
  }
}
