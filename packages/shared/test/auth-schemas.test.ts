import { describe, expect, it } from "vitest";
import { CreateRoleBody, LoginBody, Password, RegisterBody, Timezone } from "../src";

describe("auth schemas", () => {
  it("enforces the password policy", () => {
    expect(Password.safeParse("short").success).toBe(false);
    expect(Password.safeParse("alllowercaseletters").success).toBe(false);
    expect(Password.safeParse("Lower-and-UPPER").success).toBe(true);
    expect(Password.safeParse("abc123def456!").success).toBe(true);
  });

  it("normalises emails and applies defaults on register", () => {
    const r = RegisterBody.parse({
      name: " Asha ",
      email: " Asha@Example.COM ",
      password: "Str0ng-pass!",
      businessName: "Asha Dental",
    });
    expect(r).toMatchObject({ name: "Asha", email: "asha@example.com", timezone: "Asia/Kolkata" });
  });

  it("does not apply the password policy on login", () => {
    expect(LoginBody.safeParse({ email: "a@b.co", password: "old" }).success).toBe(true);
  });

  it("validates time zones and role permissions", () => {
    expect(Timezone.safeParse("Asia/Kolkata").success).toBe(true);
    expect(Timezone.safeParse("Mars/Base").success).toBe(false);
    expect(
      CreateRoleBody.safeParse({ key: "SUPERVISOR", name: "Supervisor", permissions: ["hack:all"] }).success,
    ).toBe(false);
    expect(
      CreateRoleBody.parse({
        key: "SUPERVISOR",
        name: "Supervisor",
        permissions: ["calls:read", "calls:read"],
      }).permissions,
    ).toEqual(["calls:read"]);
  });
});
