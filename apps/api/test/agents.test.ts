import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { createTestApp, hasTestDb, registerOwner } from "./support/app";
import { phoneCall, twilioPost } from "./support/telephony";

describe.skipIf(!hasTestDb)("agents: templates, drafts, publishing and version pinning", () => {
  let app: NestFastifyApplication;
  let owner: Awaited<ReturnType<typeof registerOwner>>;

  beforeAll(async () => {
    app = await createTestApp();
    owner = await registerOwner(app, "agents");
  });
  afterAll(() => app.close());

  const createAgent = async (templateKey = "restaurant-booking") => {
    const res = await owner.client.post("/api/v1/agents", {
      name: `Host ${Math.random().toString(36).slice(2, 7)}`,
      templateKey,
      agentName: "Nila",
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };

  it("lists templates and creates an agent as a draft personalised for the business", async () => {
    const templates = (await owner.client.get("/api/v1/agent-templates")).json().items;
    expect(templates.map((t: { key: string }) => t.key)).toEqual([
      "real-estate-ava",
      "clinic-reception",
      "hotel-reservations",
      "restaurant-booking",
      "qatar-real-estate-ar",
      "qatar-clinic-ar",
    ]);

    const id = await createAgent();
    const agent = (await owner.client.get(`/api/v1/agents/${id}`)).json();
    expect(agent).toMatchObject({
      status: "INACTIVE",
      published: null,
      draft: { version: 1, status: "DRAFT" },
    });
    expect(agent.draft.config).toMatchObject({ businessName: "agents Business", agentName: "Nila" });
  });

  it("rejects an unknown template and invalid configs with precise paths", async () => {
    expect(
      (await owner.client.post("/api/v1/agents", { name: "X agent", templateKey: "spaceship" })).statusCode,
    ).toBe(400);
    const id = await createAgent();
    const draft = (await owner.client.get(`/api/v1/agents/${id}`)).json().draft.config;
    draft.qualificationFields[0].key = "Bad Key";
    draft.greeting = "Hi {{nope}}";
    const res = await owner.client.request("PUT", `/api/v1/agents/${id}/draft`, { config: draft });
    expect(res.statusCode).toBe(400);
    const paths = res.json().errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["config.qualificationFields.0.key", "config.greeting"]));
  });

  it("publishes, activates, and refuses to activate or publish out of order", async () => {
    const id = await createAgent();
    expect((await owner.client.post(`/api/v1/agents/${id}/status`, { status: "ACTIVE" })).statusCode).toBe(
      409,
    );
    const pub = await owner.client.post(`/api/v1/agents/${id}/publish`);
    expect(pub.statusCode).toBe(201);
    expect(pub.json()).toMatchObject({ version: 1, status: "PUBLISHED" });
    expect((await owner.client.post(`/api/v1/agents/${id}/publish`)).statusCode).toBe(409); // nothing left to publish
    const agent = (await owner.client.get(`/api/v1/agents/${id}`)).json();
    expect(agent).toMatchObject({ status: "ACTIVE", published: { version: 1 }, draft: null });
    expect(
      (await owner.client.post(`/api/v1/agents/${id}/status`, { status: "INACTIVE" })).json().status,
    ).toBe("INACTIVE");
  });

  it("calls in progress keep their version; new calls get the newly published one", async () => {
    const id = await createAgent("restaurant-booking");
    await owner.client.post(`/api/v1/agents/${id}/publish`);
    const e164 = `+9160${Math.floor(1e7 + Math.random() * 8e7)}`;
    await owner.client.post("/api/v1/phone-numbers", { e164, agentId: id });

    const ongoing = await phoneCall(app, e164, []);
    expect(ongoing.last.say).toContain("What name should I put the booking under?");

    // Edit and publish v2 while that call is still going
    const draft = (await owner.client.get(`/api/v1/agents/${id}`)).json().published.config;
    draft.qualificationFields[0].question = "Whose name is the table for?";
    expect(
      (
        await owner.client.request("PUT", `/api/v1/agents/${id}/draft`, {
          config: draft,
          changeNote: "Friendlier",
        })
      ).statusCode,
    ).toBe(200);
    expect((await owner.client.post(`/api/v1/agents/${id}/publish`)).json().version).toBe(2);

    const next = await twilioPost(app, ongoing.last.next!, { ...ongoing.base, SpeechResult: "" });
    expect(next.twiml.say).toContain("What name should I put the booking under?"); // still v1

    const fresh = await phoneCall(app, e164, []);
    expect(fresh.last.say).toContain("Whose name is the table for?");

    const versions = await app
      .get(TenantDbService)
      .db(owner.me.tenant.id)
      .agentVersion.findMany({ where: { agentId: id }, orderBy: { version: "asc" } });
    expect(versions.map((v) => v.status)).toEqual(["RETIRED", "PUBLISHED"]);
  });

  it("summarises calls for the dashboard", async () => {
    const res = await owner.client.get("/api/v1/analytics/summary?days=7");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.series).toHaveLength(7);
    expect(body.totals.calls).toBeGreaterThanOrEqual(2);
    expect(body.series.reduce((n: number, d: { calls: number }) => n + d.calls, 0)).toBe(body.totals.calls);
  });
});
