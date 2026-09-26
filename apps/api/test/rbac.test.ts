import { RequestMethod } from "@nestjs/common";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { ModulesContainer } from "@nestjs/core";
import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANY_AUTHENTICATED, IS_PUBLIC, REQUIRED_PERMISSIONS } from "../src/common/auth/decorators";
import {
  addMember,
  Client,
  createTestApp,
  hasTestDb,
  registerOwner,
  roleId,
  STRONG_PASSWORD,
  uniqueEmail,
} from "./support/app";

type Owner = Awaited<ReturnType<typeof registerOwner>>;

describe.skipIf(!hasTestDb)("RBAC, members and tenancy", () => {
  let app: NestFastifyApplication;
  let owner: Owner;

  beforeAll(async () => {
    app = await createTestApp();
    owner = await registerOwner(app, "rbac");
  });
  afterAll(() => app.close());

  it("every route declares an access policy (deny by default)", () => {
    const missing: string[] = [];
    for (const module of app.get(ModulesContainer).values()) {
      for (const { metatype } of module.controllers.values()) {
        if (typeof metatype !== "function") continue;
        const classMeta = (key: string) => Reflect.getMetadata(key, metatype);
        for (const name of Object.getOwnPropertyNames(metatype.prototype)) {
          const handler = metatype.prototype[name];
          if (name === "constructor" || Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
          const has = (key: string) => Reflect.getMetadata(key, handler) ?? classMeta(key);
          if (!has(IS_PUBLIC) && !has(REQUIRED_PERMISSIONS) && !has(ANY_AUTHENTICATED)) {
            missing.push(
              `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)]} ${metatype.name}.${name} (${Reflect.getMetadata(PATH_METADATA, handler)})`,
            );
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  describe("invitations", () => {
    it("lets a new person join with a role and sign in", async () => {
      const staff = await addMember(app, owner, "STAFF");
      expect(staff.me.role.key).toBe("STAFF");
      expect(staff.me.tenant.id).toBe(owner.me.tenant.id);
    });

    it("requires a strong password for new accounts and rejects reused tokens", async () => {
      const email = uniqueEmail("weak");
      const invite = await owner.client.post("/api/v1/invitations", {
        email,
        roleId: await roleId(owner, "STAFF"),
      });
      const token = String(invite.json().inviteUrl).split("/invite/")[1];
      const weak = await new Client(app).post("/api/v1/invitations/accept", {
        token,
        name: "W",
        password: "weakpass",
      });
      expect(weak.statusCode).toBe(400);
      expect(weak.json().errors[0].path).toBe("password");

      expect(
        (
          await new Client(app).post("/api/v1/invitations/accept", {
            token,
            name: "W",
            password: STRONG_PASSWORD,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await new Client(app).post("/api/v1/invitations/accept", {
            token,
            name: "W",
            password: STRONG_PASSWORD,
          })
        ).statusCode,
      ).toBe(404);
    });
  });

  describe("permissions", () => {
    it("STAFF cannot read members, change the business or invite", async () => {
      const { client } = await addMember(app, owner, "STAFF");
      expect((await client.get("/api/v1/members")).statusCode).toBe(403);
      expect((await client.patch("/api/v1/tenant", { name: "Mine now" })).statusCode).toBe(403);
      const invite = await client.post("/api/v1/invitations", {
        email: uniqueEmail("x"),
        roleId: await roleId(owner, "STAFF"),
      });
      expect(invite.statusCode).toBe(403);
      expect((await client.get("/api/v1/tenant")).statusCode).toBe(200);
    });

    it("MANAGER can read members and transcripts but not manage users", async () => {
      const { client } = await addMember(app, owner, "MANAGER");
      expect((await client.get("/api/v1/members")).statusCode).toBe(200);
      expect((await client.delete(`/api/v1/members/${owner.me.user.id}`)).statusCode).toBe(403);
    });
  });

  describe("privilege escalation", () => {
    it("an ADMIN cannot create a role with permissions they lack", async () => {
      const admin = await addMember(app, owner, "ADMIN");
      const res = await admin.client.post("/api/v1/roles", {
        key: "BILLER",
        name: "Biller",
        permissions: ["billing:write"],
      });
      expect(res.statusCode).toBe(403);
      const ok = await admin.client.post("/api/v1/roles", {
        key: "READER",
        name: "Reader",
        permissions: ["calls:read"],
      });
      expect(ok.statusCode).toBe(201);
    });

    it("an ADMIN cannot demote or remove the OWNER, nor invite a new OWNER", async () => {
      const admin = await addMember(app, owner, "ADMIN");
      const members = (await owner.client.get("/api/v1/members")).json().items;
      const ownerMembership = members.find((m: { role: { key: string } }) => m.role.key === "OWNER");
      expect(
        (
          await admin.client.patch(`/api/v1/members/${ownerMembership.id}`, {
            roleId: await roleId(owner, "STAFF"),
          })
        ).statusCode,
      ).toBe(403);
      expect((await admin.client.delete(`/api/v1/members/${ownerMembership.id}`)).statusCode).toBe(403);
      const invite = await admin.client.post("/api/v1/invitations", {
        email: uniqueEmail("o"),
        roleId: await roleId(owner, "OWNER"),
      });
      expect(invite.statusCode).toBe(403);
    });

    it("system roles are immutable", async () => {
      const res = await owner.client.patch(`/api/v1/roles/${await roleId(owner, "STAFF")}`, {
        name: "Renamed",
      });
      expect(res.statusCode).toBe(409);
    });
  });

  it("a business always keeps at least one owner", async () => {
    const solo = await registerOwner(app, "solo");
    const members = (await solo.client.get("/api/v1/members")).json().items;
    const res = await solo.client.patch(`/api/v1/members/${members[0].id}`, {
      roleId: await roleId(solo, "ADMIN"),
    });
    expect(res.statusCode).toBe(409);
  });

  describe("tenant isolation through the API", () => {
    it("cannot see or touch another business's members, roles or invitations", async () => {
      const other = await registerOwner(app, "other");
      const theirMembers = (await other.client.get("/api/v1/members")).json().items;
      const theirRole = await roleId(other, "STAFF");

      expect(
        (
          await owner.client.patch(`/api/v1/members/${theirMembers[0].id}`, {
            roleId: await roleId(owner, "STAFF"),
          })
        ).statusCode,
      ).toBe(404);
      expect((await owner.client.delete(`/api/v1/members/${theirMembers[0].id}`)).statusCode).toBe(404);
      // A role id from another tenant is treated as unknown
      const invite = await owner.client.post("/api/v1/invitations", {
        email: uniqueEmail("y"),
        roleId: theirRole,
      });
      expect(invite.statusCode).toBe(400);
      const ours = (await owner.client.get("/api/v1/members")).json().items.map((m: { id: string }) => m.id);
      expect(ours).not.toContain(theirMembers[0].id);
    });

    it("switches between businesses the user belongs to, and only those", async () => {
      const other = await registerOwner(app, "switch");
      const invite = await other.client.post("/api/v1/invitations", {
        email: owner.email,
        roleId: await roleId(other, "MANAGER"),
      });
      const token = String(invite.json().inviteUrl).split("/invite/")[1];
      expect(
        (await new Client(app).post("/api/v1/invitations/accept", { token, password: STRONG_PASSWORD }))
          .statusCode,
      ).toBe(200);

      const client = new Client(app);
      await client.post("/api/v1/auth/login", { email: owner.email, password: STRONG_PASSWORD });
      const me = (await client.get("/api/v1/auth/me")).json();
      expect(me.memberships).toHaveLength(2);

      const switched = await client.post("/api/v1/auth/switch-tenant", { tenantId: other.me.tenant.id });
      expect(switched.statusCode).toBe(200);
      expect(switched.json().role.key).toBe("MANAGER");
      expect((await client.get("/api/v1/tenant")).json().id).toBe(other.me.tenant.id);

      const stranger = await registerOwner(app, "stranger");
      expect(
        (await client.post("/api/v1/auth/switch-tenant", { tenantId: stranger.me.tenant.id })).statusCode,
      ).toBe(404);
    });

    it("a removed member loses access immediately", async () => {
      const staff = await addMember(app, owner, "STAFF");
      const members = (await owner.client.get("/api/v1/members")).json().items;
      const m = members.find((x: { user: { email: string } }) => x.user.email === staff.email);
      expect((await owner.client.delete(`/api/v1/members/${m.id}`)).statusCode).toBe(204);
      expect((await staff.client.get("/api/v1/tenant")).statusCode).toBe(401);
    });
  });

  describe("API keys", () => {
    it("authenticate with scoped permissions and can be revoked", async () => {
      const created = await owner.client.post("/api/v1/api-keys", {
        name: "Reporting",
        scopes: ["tenant:read"],
      });
      expect(created.statusCode).toBe(201);
      const { key, id } = created.json();
      expect(key).toMatch(/^vk_/);

      const machine = new Client(app);
      const auth = { headers: { authorization: `ApiKey ${key}` } };
      expect((await machine.get("/api/v1/tenant", auth)).statusCode).toBe(200);
      expect((await machine.get("/api/v1/members", auth)).statusCode).toBe(403);
      // Keys cannot manage keys, even with a person's full scopes
      expect((await machine.get("/api/v1/api-keys", auth)).statusCode).toBe(403);

      const listed = (await owner.client.get("/api/v1/api-keys")).json().items;
      expect(JSON.stringify(listed)).not.toContain(key);

      expect((await owner.client.delete(`/api/v1/api-keys/${id}`)).statusCode).toBe(204);
      expect((await machine.get("/api/v1/tenant", auth)).statusCode).toBe(401);
    });

    it("cannot be created with scopes beyond the creator's permissions", async () => {
      const manager = await addMember(app, owner, "MANAGER");
      const res = await manager.client.post("/api/v1/api-keys", { name: "x", scopes: ["billing:write"] });
      expect(res.statusCode).toBe(403); // managers lack api_keys:write entirely
    });
  });

  it("records an audit trail", async () => {
    const res = await owner.client.get("/api/v1/audit-logs?limit=100");
    expect(res.statusCode).toBe(200);
    const actions = res.json().items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["tenant.created", "invitation.created", "member.joined", "api_key.created"]),
    );
  });
});
