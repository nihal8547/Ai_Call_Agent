import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import { tokenCache } from "@platform/tools";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { addMember, Client, createTestApp, hasTestDb, registerOwner } from "./support/app";
import { phoneCall, provisionAgent, twilioPost } from "./support/telephony";

type Owner = Awaited<ReturnType<typeof registerOwner>>;
type Seen = { method: string; url: URL; auth: string; body: Record<string, unknown> };

// ── A fake HubSpot and Zoho behind fetch; everything else goes to the network ─────────
const crm = {
  seen: [] as Seen[],
  contacts: new Map<string, Record<string, string>>(),
  zohoLeads: new Map<string, Record<string, unknown>>(),
  hubspotStatus: 200,
};
const HUBSPOT_PROPS = [
  { name: "firstname", label: "First Name", type: "string", fieldType: "text" },
  {
    name: "service",
    label: "Service",
    type: "enumeration",
    fieldType: "select",
    options: [
      { label: "Dental cleaning", value: "cleaning" },
      { label: "Braces", value: "braces" },
      { label: "Root canal", value: "root_canal" },
      { label: "Dental implants", value: "implants" },
      { label: "Teeth whitening", value: "whitening" },
      { label: "General consultation", value: "consultation" },
      { label: "Other", value: "other" },
    ],
  },
  { name: "urgency_level", label: "Urgency", type: "string", fieldType: "text" },
  { name: "call_notes", label: "Call notes", type: "string", fieldType: "textarea" },
  { name: "budget", label: "Budget", type: "number", fieldType: "number" },
];
const realFetch = globalThis.fetch;
function installFakeCrm() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const hubspot = url.hostname === "api.hubapi.com";
    const zoho = url.hostname.includes("zoho");
    if (!hubspot && !zoho) return realFetch(input, init);
    const raw =
      typeof init.body === "string"
        ? init.body
        : init.body instanceof URLSearchParams
          ? init.body.toString()
          : "";
    const body = raw.startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    const auth = String((init.headers as Record<string, string> | undefined)?.authorization ?? "");
    crm.seen.push({ method: init.method ?? "GET", url, auth, body });
    if (hubspot) {
      if (url.pathname === "/oauth/v1/token")
        return Response.json({ access_token: "hs-at", refresh_token: "hs-rt", expires_in: 1800 });
      if (crm.hubspotStatus !== 200)
        return Response.json(
          { message: "Authentication credentials not found" },
          { status: crm.hubspotStatus },
        );
      if (url.pathname === "/crm/v3/properties/contacts") return Response.json({ results: HUBSPOT_PROPS });
      if (url.pathname === "/crm/v3/objects/contacts/search") return Response.json({ results: [] });
      if (url.pathname === "/crm/v3/objects/contacts" && init.method === "POST") {
        const id = String(1000 + crm.contacts.size);
        crm.contacts.set(id, body.properties);
        return Response.json({ id }, { status: 201 });
      }
      const m = /^\/crm\/v3\/objects\/contacts\/(\d+)$/.exec(url.pathname);
      if (m && init.method === "PATCH") {
        if (!crm.contacts.has(m[1]!)) return Response.json({ message: "not found" }, { status: 404 });
        crm.contacts.set(m[1]!, { ...crm.contacts.get(m[1]!)!, ...body.properties });
        return Response.json({ id: m[1] });
      }
    }
    if (zoho) {
      if (url.pathname === "/oauth/v2/token")
        return Response.json({
          access_token: "z-at",
          api_domain: "https://www.zohoapis.in",
          expires_in: 3600,
        });
      if (url.pathname === "/crm/v6/settings/fields")
        return Response.json({
          fields: [
            { api_name: "Last_Name", field_label: "Last Name", data_type: "text", system_mandatory: true },
            { api_name: "Description", field_label: "Description", data_type: "textarea" },
          ],
        });
      if (url.pathname === "/crm/v6/Leads/upsert") {
        const id = `4150${crm.zohoLeads.size}`;
        crm.zohoLeads.set(id, (body.data as Record<string, unknown>[])[0]!);
        return Response.json({
          data: [{ code: "SUCCESS", status: "success", message: "record added", details: { id } }],
        });
      }
    }
    return Response.json({ message: `unexpected ${url.pathname}` }, { status: 500 });
  });
}

describe.skipIf(!hasTestDb)("P11: CRM sync (HubSpot, Zoho) with field mapping", () => {
  let app: NestFastifyApplication;
  let owner: Owner;
  let clinic: Awaited<ReturnType<typeof provisionAgent>>;
  let hubspotId = "";
  const db = () => app.get(TenantDbService).db(owner.me.tenant.id);

  beforeAll(async () => {
    installFakeCrm();
    app = await createTestApp({
      HUBSPOT_CLIENT_ID: "hubspot-client-id",
      HUBSPOT_CLIENT_SECRET: "hubspot-client-secret",
    });
    owner = await registerOwner(app, "crm");
    clinic = await provisionAgent(app, owner.me.tenant.id, "clinic-reception", { workingHours: undefined });
  });
  beforeEach(() => {
    crm.seen.length = 0;
    tokenCache.clear();
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it("connects HubSpot with a private app token and checks the mapping against HubSpot's fields", async () => {
    const res = await owner.client.post("/api/v1/integrations", {
      type: "HUBSPOT",
      name: "HubSpot",
      config: { syncLeads: true, mapping: {} },
      credentials: { kind: "private_app", token: "pat-na1-11111111-2222-3333" },
    });
    expect(res.statusCode, res.body).toBe(201);
    hubspotId = res.json().id;
    expect(res.body).not.toContain("pat-na1");
    const tested = await owner.client.post(`/api/v1/integrations/${hubspotId}/test`);
    expect(tested.json()).toEqual({ ok: true, message: "Connected to HubSpot (5 contact properties)" });
    expect(crm.seen[0]!.auth).toBe("Bearer pat-na1-11111111-2222-3333");

    const view = (await owner.client.get(`/api/v1/integrations/${hubspotId}/crm-mapping`)).json();
    expect(view.sources.map((s: { key: string }) => s.key)).toEqual(
      expect.arrayContaining(["patient_name", "service_required", "urgency", "@summary", "@status"]),
    );
    expect(view.properties.map((p: { name: string }) => p.name)).toContain("service");

    const bad = await owner.client.request("PUT", `/api/v1/integrations/${hubspotId}/crm-mapping`, {
      syncLeads: true,
      mapping: { patient_name: "budget", service_required: "nope" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors).toEqual([
      { path: "mapping.patient_name", message: '"Budget" is a number field; Patient name is name' },
      { path: "mapping.service_required", message: 'The CRM has no writable field "nope"' },
    ]);
    const good = await owner.client.request("PUT", `/api/v1/integrations/${hubspotId}/crm-mapping`, {
      syncLeads: true,
      mapping: { service_required: "service", urgency: "urgency_level", "@summary": "call_notes" },
    });
    expect(good.statusCode, good.body).toBe(200);
  });

  it("sends the caller to HubSpot after the call, and staff edits update the same contact", async () => {
    const call = await phoneCall(app, clinic.e164, ["Priya Nair", "cleaning", "flexible"]);
    await twilioPost(app, "/telephony/twilio/status", {
      ...call.base,
      CallStatus: "completed",
      CallDuration: "40",
    });
    const leadOf = () =>
      db().lead.findFirstOrThrow({ where: { customerName: "Priya Nair" }, orderBy: { createdAt: "desc" } });
    await vi.waitFor(async () => {
      const lead = await leadOf();
      expect((lead.crmSync as Record<string, { status: string }>)[hubspotId]?.status).toBe("synced");
    });
    const lead = await leadOf();
    const state = (lead.crmSync as Record<string, { externalId: string }>)[hubspotId]!;
    expect(lead.syncedToCrm).toBe(true);
    expect(crm.contacts.get(state.externalId)).toMatchObject({
      firstname: "Priya",
      lastname: "Nair",
      service: "cleaning",
      urgency_level: "Flexible",
      call_notes: expect.stringContaining("Patient name: Priya Nair"),
    });

    // Staff change the service; the same contact is updated, not duplicated
    const patched = await owner.client.patch(`/api/v1/leads/${lead.id}`, {
      data: { service_required: "Braces" },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    await vi.waitFor(() => expect(crm.contacts.get(state.externalId)?.service).toBe("braces"));
    expect(
      crm.seen.some((s) => s.method === "PATCH" && s.url.pathname.endsWith(`/${state.externalId}`)),
    ).toBe(true);
    const listed = (await owner.client.get("/api/v1/leads?q=Priya")).json().items[0];
    expect(listed.crmSync[hubspotId]).toMatchObject({
      status: "synced",
      externalId: state.externalId,
      error: null,
    });
  });

  it("a revoked token flags the integration, marks the lead failed and lists the job for staff", async () => {
    crm.hubspotStatus = 401;
    try {
      const call = await phoneCall(app, clinic.e164, ["Arjun Rao", "braces", "flexible"]);
      await twilioPost(app, "/telephony/twilio/status", {
        ...call.base,
        CallStatus: "completed",
        CallDuration: "30",
      });
      await vi.waitFor(async () => {
        const lead = await db().lead.findFirstOrThrow({ where: { customerName: "Arjun Rao" } });
        expect((lead.crmSync as Record<string, { status: string }>)[hubspotId]).toMatchObject({
          status: "failed",
          error: "HubSpot: Authentication credentials not found",
        });
      });
      const integration = await db().integration.findUniqueOrThrow({ where: { id: hubspotId } });
      expect(integration).toMatchObject({
        status: "ERROR",
        lastError: "HubSpot: Authentication credentials not found",
      });
      const failed = (await owner.client.get("/api/v1/jobs/failed")).json().items;
      expect(failed[0]).toMatchObject({ queue: "crm", label: "Send lead Arjun Rao to HubSpot", attempts: 1 });
      // While it needs attention, new leads are not queued for it
      crm.seen.length = 0;
      const lead = await db().lead.findFirstOrThrow({ where: { customerName: "Arjun Rao" } });
      await owner.client.post(`/api/v1/leads/${lead.id}/crm-sync`);
      await new Promise((r) => setTimeout(r, 100));
      expect(crm.seen).toEqual([]);
    } finally {
      crm.hubspotStatus = 200;
    }
    // Reconnect (the test passes again) and send it now
    expect((await owner.client.post(`/api/v1/integrations/${hubspotId}/test`)).json().ok).toBe(true);
    const lead = await db().lead.findFirstOrThrow({ where: { customerName: "Arjun Rao" } });
    const synced = await owner.client.post(`/api/v1/leads/${lead.id}/crm-sync`);
    expect(synced.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const l = await db().lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect((l.crmSync as Record<string, { status: string }>)[hubspotId]?.status).toBe("synced");
    });
  });

  it("syncs to Zoho CRM in the business's data center with a Self Client", async () => {
    const zoho = await owner.client.post("/api/v1/integrations", {
      type: "ZOHO",
      name: "Zoho India",
      config: { syncLeads: true, mapping: { "@summary": "Description" } },
      credentials: {
        kind: "self_client",
        clientId: "1000.ABCDEFGHIJ",
        clientSecret: "zoho-client-secret-123",
        refreshToken: "1000.refresh.token.xyz",
        accountsServer: "https://accounts.zoho.in",
      },
    });
    expect(zoho.statusCode, zoho.body).toBe(201);
    expect(zoho.json().config).toMatchObject({ dataCenter: "https://accounts.zoho.in" });
    const call = await phoneCall(app, clinic.e164, ["Meera", "root canal", "flexible"]);
    await twilioPost(app, "/telephony/twilio/status", {
      ...call.base,
      CallStatus: "completed",
      CallDuration: "20",
    });
    await vi.waitFor(() =>
      expect([...crm.zohoLeads.values()]).toContainEqual(
        expect.objectContaining({
          Last_Name: "Meera",
          Lead_Source: "Phone call",
          Description: expect.stringContaining("Root canal"),
        }),
      ),
    );
    expect(crm.seen.find((s) => s.url.pathname === "/oauth/v2/token")!.url.origin).toBe(
      "https://accounts.zoho.in",
    );
    expect(crm.seen.find((s) => s.url.pathname === "/crm/v6/Leads/upsert")!.url.origin).toBe(
      "https://www.zohoapis.in",
    );
  });

  it("Connect with HubSpot: only the browser that started it can finish it", async () => {
    const start = await owner.client.get("/api/v1/integrations/oauth/hubspot/start?name=HubSpot%20OAuth");
    expect(start.statusCode, start.body).toBe(200);
    const url = new URL(start.json().url);
    expect(url.origin + url.pathname).toBe("https://app.hubspot.com/oauth/authorize");
    expect(url.searchParams.get("scope")).toContain("crm.objects.contacts.write");
    const state = url.searchParams.get("state")!;

    // A different browser (no binding cookie) is sent to login and the state is burned
    const stranger = new Client(app);
    const forged = await stranger.get(`/api/v1/integrations/oauth/hubspot/callback?state=${state}&code=abc`);
    expect(forged.statusCode).toBe(302);
    expect(forged.headers.location).toMatch(/\/login$/);

    const again = await owner.client.get("/api/v1/integrations/oauth/hubspot/start?name=HubSpot%20OAuth");
    const state2 = new URL(again.json().url).searchParams.get("state")!;
    const done = await owner.client.get(
      `/api/v1/integrations/oauth/hubspot/callback?state=${state2}&code=good-code`,
    );
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toMatch(/\/integrations\?connected=/);
    const exchange = crm.seen.find((s) => s.url.pathname === "/oauth/v1/token")!;
    expect(exchange.body).toMatchObject({
      grant_type: "authorization_code",
      code: "good-code",
      client_id: "hubspot-client-id",
    });
    const row = await db().integration.findFirstOrThrow({ where: { name: "HubSpot OAuth" } });
    expect(row).toMatchObject({ type: "HUBSPOT", status: "CONNECTED" });

    // Zoho sign-in is not configured on this platform
    const zoho = await owner.client.get("/api/v1/integrations/oauth/zoho/start?name=Zoho");
    expect(zoho.statusCode).toBe(409);
  });

  it("only integration managers see or change the mapping", async () => {
    const staff = await addMember(app, owner, "STAFF");
    expect((await staff.client.get(`/api/v1/integrations/${hubspotId}/crm-mapping`)).statusCode).toBe(403);
    const manager = await addMember(app, owner, "MANAGER");
    expect((await manager.client.get(`/api/v1/integrations/${hubspotId}/crm-mapping`)).statusCode).toBe(200);
    expect(
      (
        await manager.client.request("PUT", `/api/v1/integrations/${hubspotId}/crm-mapping`, {
          syncLeads: false,
          mapping: {},
        })
      ).statusCode,
    ).toBe(403);
    const outsider = await registerOwner(app, "crm-outsider");
    expect((await outsider.client.get(`/api/v1/integrations/${hubspotId}/crm-mapping`)).statusCode).toBe(404);
  });
});
