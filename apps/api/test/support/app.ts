import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createApp } from "../../src/bootstrap";
import { loadApiEnv } from "../../src/config/env";
import { PrismaService } from "../../src/infra/prisma.service";

try {
  process.loadEnvFile(path.resolve(__dirname, "../../../../.env"));
} catch {
  // CI provides variables directly
}

export const TWILIO_TOKEN = "test-twilio-auth-token-0123456789";
export const PUBLIC_URL = "https://voice.test";

/** Uploaded files from integration tests land here, away from the development storage */
export const TEST_STORAGE_DIR = path.join(os.tmpdir(), "platform-api-test-storage");

export const hasTestDb = Boolean(process.env.TEST_APP_DATABASE_URL && process.env.REDIS_URL);

/** The real application wired to the integration-test database (RLS app role) */
export async function createTestApp(overrides: Record<string, string> = {}): Promise<NestFastifyApplication> {
  const env = loadApiEnv({
    ...process.env,
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL,
    JWT_SECRET: process.env.JWT_SECRET ?? "test-only-jwt-secret-0123456789abcdefghij",
    MASTER_ENCRYPTION_KEY: process.env.MASTER_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64"),
    TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
    PUBLIC_BASE_URL: PUBLIC_URL,
    GEMINI_API_KEY: undefined,
    EMBEDDINGS_PROVIDER: "hashing",
    // Each test app its own queues: away from a development worker and from other test files
    QUEUE_PREFIX: `test-${randomBytes(4).toString("hex")}`,
    // Retries within milliseconds instead of seconds
    QUEUE_BACKOFF_SCALE: "0.002",
    // Tools talk to local test servers (webhook receiver, SMTP)
    ALLOW_PRIVATE_NETWORK_TOOLS: "true",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: TEST_STORAGE_DIR,
    ...overrides,
  });
  const app = await createApp(env, { logger: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

type InjectResponse = Awaited<ReturnType<NestFastifyApplication["inject"]>>;

/**
 * A tiny browser: keeps cookies between requests and sends the CSRF header like the web app does.
 */
export class Client {
  private cookies = new Map<string, string>();
  /** Each simulated browser gets its own IP so IP rate limits behave like real traffic */
  readonly ip = `10.${rand()}.${rand()}.${rand()}`;

  constructor(private readonly app: NestFastifyApplication) {}

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }
  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  async request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    body?: unknown,
    opts: { csrf?: boolean; headers?: Record<string, string> } = {},
  ): Promise<InjectResponse> {
    const headers: Record<string, string> = { ...opts.headers };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const csrf = this.cookies.get("csrf_token");
    if (opts.csrf !== false && csrf && method !== "GET") headers["x-csrf-token"] = csrf;
    const res = await this.app.inject({
      method,
      url,
      headers,
      remoteAddress: this.ip,
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    });
    for (const c of res.cookies as { name: string; value: string; maxAge?: number; expires?: Date }[]) {
      const expired = c.maxAge === 0 || (c.expires && c.expires.getTime() <= Date.now()) || c.value === "";
      if (expired) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }

  get = (url: string, opts?: { headers?: Record<string, string> }) =>
    this.request("GET", url, undefined, opts);
  post = (url: string, body?: unknown, opts?: { csrf?: boolean; headers?: Record<string, string> }) =>
    this.request("POST", url, body ?? {}, opts);
  patch = (url: string, body?: unknown, opts?: { csrf?: boolean }) =>
    this.request("PATCH", url, body ?? {}, opts);
  delete = (url: string, opts?: { csrf?: boolean }) => this.request("DELETE", url, undefined, opts);
}

function rand(): number {
  return Math.floor(Math.random() * 254) + 1;
}

let seq = 0;
export function uniqueEmail(label: string): string {
  return `${label}-${Date.now().toString(36)}-${(seq++).toString(36)}@example.com`;
}

export const STRONG_PASSWORD = "Str0ng-Passw0rd!";

/** A new owner; their email counts as confirmed unless `verified: false` */
export async function registerOwner(
  app: NestFastifyApplication,
  label: string,
  { verified = true }: { verified?: boolean } = {},
) {
  const client = new Client(app);
  const email = uniqueEmail(label);
  const res = await client.post("/api/v1/auth/register", {
    name: `${label} owner`,
    email,
    password: STRONG_PASSWORD,
    businessName: `${label} Business`,
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  if (verified)
    await app
      .get(PrismaService)
      .client.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  return {
    client,
    email,
    me: res.json() as { tenant: { id: string }; user: { id: string }; role: { key: string } },
  };
}

type Owner = Awaited<ReturnType<typeof registerOwner>>;

export async function roleId(owner: Owner, key: string): Promise<string> {
  const res = await owner.client.get("/api/v1/roles");
  return res.json().items.find((r: { key: string }) => r.key === key).id;
}

/** Invite someone with a system role and return their signed-in client */
export async function addMember(app: NestFastifyApplication, owner: Owner, key: string) {
  const email = uniqueEmail(key.toLowerCase());
  const invite = await owner.client.post("/api/v1/invitations", { email, roleId: await roleId(owner, key) });
  if (invite.statusCode !== 201) throw new Error(`invite failed: ${invite.statusCode} ${invite.body}`);
  const token = String(invite.json().inviteUrl).split("/invite/")[1];
  const client = new Client(app);
  const res = await client.post("/api/v1/invitations/accept", {
    token,
    name: key,
    password: STRONG_PASSWORD,
  });
  if (res.statusCode !== 200) throw new Error(`accept failed: ${res.statusCode} ${res.body}`);
  return { client, email, me: res.json() };
}
