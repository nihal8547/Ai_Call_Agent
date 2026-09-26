import { describe, expect, it } from "vitest";
import {
  BUILTIN_CRM_SOURCES,
  buildCrmRecord,
  type CrmProperty,
  hubspotProperties,
  hubspotUpsertContact,
  tokenCache,
  validateCrmMapping,
  zohoFields,
  zohoUpsertLead,
} from "../src";

type Seen = { method: string; url: string; headers: Record<string, string>; body: unknown };

/** A scripted CRM behind fetch: each handler answers one request in order */
function fakeCrm(handlers: ((r: Seen) => Response | Promise<Response>)[]) {
  const seen: Seen[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const r: Seen = {
      method: init.method ?? "GET",
      url: String(input),
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      body:
        typeof init.body === "string"
          ? JSON.parse(init.body)
          : init.body instanceof URLSearchParams
            ? Object.fromEntries(init.body)
            : null,
    };
    seen.push(r);
    const h = handlers.shift();
    if (!h) throw new Error(`unexpected request ${r.method} ${r.url}`);
    return h(r);
  }) as typeof fetch;
  return { fetch: f, seen };
}

const PROPS: CrmProperty[] = [
  {
    name: "service",
    label: "Service",
    type: "enum",
    options: [
      { label: "Dental cleaning", value: "cleaning" },
      { label: "Braces", value: "braces" },
    ],
  },
  { name: "budget", label: "Budget", type: "number" },
  { name: "notes", label: "Notes", type: "string" },
  { name: "visit_date", label: "Visit date", type: "date" },
];

describe("CRM field mapping", () => {
  const sources = [
    {
      key: "service_required",
      label: "Service",
      type: "select",
      options: ["Dental cleaning", "Braces", "Root canal"],
    },
    { key: "budget", label: "Budget", type: "currency" },
    { key: "patient_name", label: "Patient name", type: "name" },
    { key: "preferred_date", label: "Preferred date", type: "date" },
    ...BUILTIN_CRM_SOURCES,
  ];

  it("accepts compatible types and reports each problem in words", () => {
    expect(
      validateCrmMapping(
        { budget: "budget", "@summary": "notes", preferred_date: "visit_date" },
        sources,
        PROPS,
      ),
    ).toEqual([]);
    expect(
      validateCrmMapping(
        {
          service_required: "service",
          patient_name: "budget",
          preferred_date: "gone",
          budget: "notes",
          "@agent": "notes",
        },
        sources,
        PROPS,
      ),
    ).toEqual([
      { source: "service_required", message: '"Service" has no option for: Root canal' },
      { source: "patient_name", message: '"Budget" is a number field; Patient name is name' },
      { source: "preferred_date", message: 'The CRM has no writable field "gone"' },
      { source: "@agent", message: '"Notes" is already filled from Budget' },
    ]);
  });

  it("converts values for the CRM and leaves out what can't be written", () => {
    const { record, skipped } = buildCrmRecord(
      {
        customerName: "Priya Nair Menon",
        phone: "+919876543210",
        email: null,
        data: {
          service_required: "Dental cleaning",
          budget: "25,000",
          preferred_date: "2026-10-02",
          patient_name: "Priya",
        },
        summary: "Patient name: Priya",
        status: "New",
        agent: "Maya",
        callDate: new Date("2026-09-28T06:00:00Z"),
      },
      { service_required: "service", budget: "budget", preferred_date: "visit_date", "@summary": "notes" },
      PROPS,
    );
    expect(record).toEqual({
      firstName: "Priya",
      lastName: "Nair Menon",
      phone: "+919876543210",
      email: null,
      properties: {
        service: "cleaning",
        budget: 25000,
        visit_date: "2026-10-02",
        notes: "Patient name: Priya",
      },
    });
    expect(skipped).toEqual([]);
    const odd = buildCrmRecord(
      {
        customerName: null,
        phone: null,
        email: null,
        data: { service_required: "Root canal" },
        summary: null,
        status: null,
        agent: null,
        callDate: null,
      },
      { service_required: "service" },
      PROPS,
    );
    expect(odd.record.properties).toEqual({});
    expect(odd.skipped).toEqual(["service_required → Service"]);
  });
});

describe("HubSpot", () => {
  const creds = { kind: "private_app" as const, token: "pat-na1-secret" };
  const record = {
    firstName: "Priya",
    lastName: null,
    phone: "+919876543210",
    email: "priya@example.com",
    properties: { service: "cleaning" },
  };

  it("lists writable contact properties with their options", async () => {
    const crm = fakeCrm([
      () =>
        Response.json({
          results: [
            {
              name: "service",
              label: "Service",
              type: "enumeration",
              fieldType: "select",
              options: [{ label: "Cleaning", value: "cleaning" }],
            },
            { name: "hs_calc", label: "Calculated", type: "number", fieldType: "number", calculated: true },
            { name: "phone", label: "Phone Number", type: "string", fieldType: "phonenumber" },
            {
              name: "hs_ro",
              label: "Read only",
              type: "string",
              fieldType: "text",
              modificationMetadata: { readOnlyValue: true },
            },
          ],
        }),
    ]);
    const props = await hubspotProperties(creds, { fetch: crm.fetch, timeoutMs: 1000 });
    expect(props).toEqual([
      { name: "phone", label: "Phone Number", type: "phone" },
      {
        name: "service",
        label: "Service",
        type: "enum",
        options: [{ label: "Cleaning", value: "cleaning" }],
      },
    ]);
    expect(crm.seen[0]!.headers.authorization).toBe("Bearer pat-na1-secret");
  });

  it("updates the contact found by email or phone, and creates one otherwise", async () => {
    const crm = fakeCrm([
      () => Response.json({ results: [{ id: "501" }] }),
      () => Response.json({ id: "501" }),
      () => Response.json({ results: [] }),
      () => Response.json({ id: "777" }, { status: 201 }),
    ]);
    const deps = { fetch: crm.fetch, timeoutMs: 1000 };
    expect(await hubspotUpsertContact(creds, deps, record, null)).toBe("501");
    expect(crm.seen[0]!.body).toMatchObject({
      filterGroups: [
        { filters: [{ propertyName: "email", operator: "EQ", value: "priya@example.com" }] },
        { filters: [{ propertyName: "phone", operator: "EQ", value: "+919876543210" }] },
      ],
    });
    expect(crm.seen[1]).toMatchObject({
      method: "PATCH",
      url: "https://api.hubapi.com/crm/v3/objects/contacts/501",
      body: {
        properties: {
          firstname: "Priya",
          phone: "+919876543210",
          email: "priya@example.com",
          service: "cleaning",
        },
      },
    });
    expect(await hubspotUpsertContact(creds, deps, record, null)).toBe("777");
    expect(crm.seen[3]!.method).toBe("POST");
  });

  it("recreates a contact deleted in HubSpot, and reports rejected tokens as auth problems", async () => {
    const crm = fakeCrm([
      () => Response.json({ message: "not found" }, { status: 404 }),
      () => Response.json({ id: "900" }),
      () => Response.json({ message: "Authentication credentials not found" }, { status: 401 }),
    ]);
    const deps = { fetch: crm.fetch, timeoutMs: 1000 };
    expect(await hubspotUpsertContact(creds, deps, record, "501")).toBe("900");
    await expect(hubspotUpsertContact(creds, deps, record, "900")).rejects.toMatchObject({
      kind: "auth",
      message: "HubSpot: Authentication credentials not found",
    });
  });

  it("refreshes OAuth access tokens with the platform's app", async () => {
    tokenCache.clear();
    const crm = fakeCrm([
      () => Response.json({ access_token: "at-1", expires_in: 1800 }),
      () => Response.json({ results: [] }),
      () => Response.json({ results: [] }),
    ]);
    const deps = {
      fetch: crm.fetch,
      timeoutMs: 1000,
      oauthClient: { clientId: "cid", clientSecret: "csecret" },
    };
    await hubspotProperties({ kind: "oauth", refreshToken: "rt-1" }, deps);
    await hubspotProperties({ kind: "oauth", refreshToken: "rt-1" }, deps);
    expect(crm.seen.map((s) => s.url)).toEqual([
      "https://api.hubapi.com/oauth/v1/token",
      "https://api.hubapi.com/crm/v3/properties/contacts",
      "https://api.hubapi.com/crm/v3/properties/contacts",
    ]);
    expect(crm.seen[0]!.body).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rt-1",
      client_id: "cid",
    });
    expect(crm.seen[2]!.headers.authorization).toBe("Bearer at-1");
  });
});

describe("Zoho CRM", () => {
  const creds = {
    kind: "self_client" as const,
    clientId: "1000.CLIENT",
    clientSecret: "zsecret",
    refreshToken: "1000.refresh",
    accountsServer: "https://accounts.zoho.in",
  };
  const token = () =>
    Response.json({ access_token: "1000.at", api_domain: "https://www.zohoapis.in", expires_in: 3600 });

  it("uses the data center's accounts server and API domain", async () => {
    tokenCache.clear();
    const crm = fakeCrm([
      token,
      () =>
        Response.json({
          fields: [
            { api_name: "Last_Name", field_label: "Last Name", data_type: "text", system_mandatory: true },
            {
              api_name: "Service",
              field_label: "Service",
              data_type: "picklist",
              pick_list_values: [
                { display_value: "-None-", actual_value: "-None-" },
                { display_value: "Cleaning", actual_value: "Cleaning" },
              ],
            },
            { api_name: "Created_Time", field_label: "Created Time", data_type: "datetime", read_only: true },
            { api_name: "Owner", field_label: "Owner", data_type: "ownerlookup" },
          ],
        }),
    ]);
    const fields = await zohoFields(creds, { fetch: crm.fetch, timeoutMs: 1000 });
    expect(crm.seen[0]!.url).toBe("https://accounts.zoho.in/oauth/v2/token");
    expect(crm.seen[1]!.url).toBe("https://www.zohoapis.in/crm/v6/settings/fields?module=Leads");
    expect(crm.seen[1]!.headers.authorization).toBe("Zoho-oauthtoken 1000.at");
    expect(fields).toEqual([
      { name: "Last_Name", label: "Last Name", type: "string", required: true },
      {
        name: "Service",
        label: "Service",
        type: "enum",
        options: [{ label: "Cleaning", value: "Cleaning" }],
      },
    ]);
  });

  it("upserts leads by phone, with a last name even when the caller gave none", async () => {
    tokenCache.clear();
    const crm = fakeCrm([
      token,
      () =>
        Response.json(
          {
            data: [
              {
                code: "SUCCESS",
                status: "success",
                message: "record added",
                details: { id: "4150868000001" },
              },
            ],
          },
          { status: 201 },
        ),
    ]);
    const id = await zohoUpsertLead(
      creds,
      { fetch: crm.fetch, timeoutMs: 1000 },
      {
        firstName: null,
        lastName: null,
        phone: "+919876543210",
        email: null,
        properties: { Service: "Cleaning" },
      },
      null,
    );
    expect(id).toBe("4150868000001");
    expect(crm.seen[1]).toMatchObject({
      method: "POST",
      url: "https://www.zohoapis.in/crm/v6/Leads/upsert",
      body: {
        data: [
          {
            Last_Name: "Caller +919876543210",
            Phone: "+919876543210",
            Lead_Source: "Phone call",
            Service: "Cleaning",
          },
        ],
        duplicate_check_fields: ["Phone"],
      },
    });
  });

  it("refuses an API domain that isn't Zoho's, and explains rejected records", async () => {
    tokenCache.clear();
    const evil = fakeCrm([
      () => Response.json({ access_token: "x", api_domain: "https://attacker.example" }),
    ]);
    await expect(zohoFields(creds, { fetch: evil.fetch, timeoutMs: 1000 })).rejects.toMatchObject({
      kind: "config",
    });
    tokenCache.clear();
    const crm = fakeCrm([
      token,
      () =>
        Response.json(
          { data: [{ code: "INVALID_DATA", status: "error", message: "invalid data", details: {} }] },
          { status: 400 },
        ),
    ]);
    await expect(
      zohoUpsertLead(
        creds,
        { fetch: crm.fetch, timeoutMs: 1000 },
        { firstName: "A", lastName: "B", phone: null, email: null, properties: {} },
        null,
      ),
    ).rejects.toMatchObject({ kind: "rejected", message: "Zoho CRM: invalid data" });
  });
});
