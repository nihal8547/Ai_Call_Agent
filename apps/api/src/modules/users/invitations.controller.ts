import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { hashPassword, randomToken, sha256Hex, verifyPassword } from "@platform/crypto";
import { resolveInvitation } from "@platform/db";
import { AcceptInvitationBody, CreateInvitationBody, IdParam, Password } from "@platform/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, Public, RequirePermissions, UserOnly } from "../../common/auth/decorators";
import { TokenService } from "../../common/auth/token.service";
import { AppException } from "../../common/filters/problem-details.filter";
import { requestMeta } from "../../common/http/request-meta";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RateLimit } from "../../common/rate-limit/rate-limit";
import { API_ENV, type ApiEnv } from "../../config/env";
import { PrismaService } from "../../infra/prisma.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import { EmailVerificationService } from "../auth/email-verification.service";
import { PlatformMailService } from "../mail/platform-mail.service";
import { invitationEmail } from "../mail/templates";
import { assertCanGrant } from "./access-policy";
import { RequireVerifiedEmail } from "../../common/auth/verified-email.guard";

const INVITE_TTL_DAYS = 7;

@Controller("invitations")
export class InvitationsController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly authService: AuthService,
    private readonly mail: PlatformMailService,
    private readonly verification: EmailVerificationService,
  ) {}

  /** Email the invitation (when the platform mail server is set up); the link is also returned */
  private async sendInvite(
    auth: AuthContext,
    invite: { email: string; roleName: string; token: string },
  ): Promise<{ inviteUrl: string; emailed: boolean }> {
    const inviteUrl = `${this.env.WEB_BASE_URL}/invite/${invite.token}`;
    if (!this.mail.enabled) return { inviteUrl, emailed: false };
    const [tenant, inviter] = await Promise.all([
      this.tenantDb
        .db(auth.tenantId)
        .tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { name: true } }),
      auth.kind === "user"
        ? this.prisma.client.user.findUnique({ where: { id: auth.userId }, select: { name: true } })
        : null,
    ]);
    const emailed = await this.mail.enqueue({
      purpose: "invitation",
      to: invite.email,
      ...invitationEmail({
        businessName: tenant.name,
        inviterName: inviter?.name ?? tenant.name,
        roleName: invite.roleName,
        url: inviteUrl,
        expiresDays: INVITE_TTL_DAYS,
      }),
    });
    return { inviteUrl, emailed };
  }

  @RequirePermissions("users:read")
  @Get()
  async list(@CurrentAuth() auth: AuthContext) {
    const items = await this.tenantDb.db(auth.tenantId).invitation.findMany({
      where: { acceptedAt: null },
      select: {
        id: true,
        email: true,
        expiresAt: true,
        createdAt: true,
        role: { select: { id: true, key: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return { items };
  }

  /** Returns the invitation link once; only its hash is stored */
  @RequirePermissions("users:write")
  @UserOnly()
  @Post()
  @RequireVerifiedEmail()
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(CreateInvitationBody)) body: z.output<typeof CreateInvitationBody>,
    @Req() req: FastifyRequest,
  ) {
    const created = await this.tenantDb.tx(auth.tenantId, async (tx) => {
      const role = await tx.role.findUnique({ where: { id: body.roleId } });
      if (!role)
        throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Unknown role", [
          { path: "roleId", message: "Unknown role" },
        ]);
      assertCanGrant(auth, role.permissions);

      const alreadyMember = await tx.membership.count({ where: { user: { email: body.email } } });
      if (alreadyMember)
        throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "This person is already a member");

      // Re-inviting replaces any pending invitation for the same email
      await tx.invitation.deleteMany({ where: { email: body.email, acceptedAt: null } });
      const token = randomToken(32);
      const invitation = await tx.invitation.create({
        data: {
          tenantId: auth.tenantId,
          email: body.email,
          roleId: role.id,
          tokenHash: sha256Hex(token),
          expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
        },
        select: { id: true, email: true, expiresAt: true },
      });
      await this.audit.record(tx, auth, {
        action: "invitation.created",
        entityType: "invitation",
        entityId: invitation.id,
        after: { email: body.email, role: role.key },
        ...requestMeta(req),
      });
      return { invitation, role: { id: role.id, key: role.key, name: role.name }, token };
    });
    // After the commit: the email never goes out for an invitation that wasn't saved
    const sent = await this.sendInvite(auth, {
      email: created.invitation.email,
      roleName: created.role.name,
      token: created.token,
    });
    return { ...created.invitation, role: created.role, ...sent };
  }

  /** A fresh link (the old one stops working), emailed again */
  @RequirePermissions("users:write")
  @UserOnly()
  @Post(":id/resend")
  @HttpCode(200)
  @RateLimit({ name: "invite-resend", limit: 20, windowSeconds: 3600, by: "ip" })
  async resend(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Req() req: FastifyRequest,
  ) {
    const token = randomToken(32);
    const invitation = await this.tenantDb.tx(auth.tenantId, async (tx) => {
      const found = await tx.invitation.findFirst({
        where: { id, acceptedAt: null },
        select: { id: true, role: { select: { permissions: true } } },
      });
      if (!found) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Invitation not found");
      assertCanGrant(auth, found.role.permissions);
      const updated = await tx.invitation.update({
        where: { id },
        data: { tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000) },
        select: {
          id: true,
          email: true,
          expiresAt: true,
          role: { select: { id: true, key: true, name: true } },
        },
      });
      await this.audit.record(tx, auth, {
        action: "invitation.resent",
        entityType: "invitation",
        entityId: id,
        ...requestMeta(req),
      });
      return updated;
    });
    const sent = await this.sendInvite(auth, {
      email: invitation.email,
      roleName: invitation.role.name,
      token,
    });
    return { ...invitation, ...sent };
  }

  @RequirePermissions("users:write")
  @Delete(":id")
  @HttpCode(204)
  async revoke(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Req() req: FastifyRequest,
  ): Promise<void> {
    await this.tenantDb.tx(auth.tenantId, async (tx) => {
      const { count } = await tx.invitation.deleteMany({ where: { id, acceptedAt: null } });
      if (!count) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Invitation not found");
      await this.audit.record(tx, auth, {
        action: "invitation.revoked",
        entityType: "invitation",
        entityId: id,
        ...requestMeta(req),
      });
    });
  }

  /**
   * Accept an invitation. New users choose a name and password; existing users confirm with their password.
   * Signs the user in to the inviting business.
   */
  @Public()
  @Post("accept")
  @HttpCode(200)
  @RateLimit({ name: "invite-accept", limit: 10, windowSeconds: 900, by: "ip" })
  async accept(
    @Body(new ZodValidationPipe(AcceptInvitationBody)) body: z.output<typeof AcceptInvitationBody>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const invite = await resolveInvitation(this.prisma.client, sha256Hex(body.token));
    if (!invite)
      throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "This invitation is invalid or has expired");

    let user = await this.prisma.client.user.findUnique({ where: { email: invite.email } });
    if (user) {
      if (!(await verifyPassword(user.passwordHash, body.password))) {
        throw new AppException(HttpStatus.UNAUTHORIZED, "INVALID_CREDENTIALS", "Password is incorrect");
      }
    } else {
      const password = Password.safeParse(body.password);
      if (!body.name || !password.success) {
        throw new AppException(
          HttpStatus.BAD_REQUEST,
          "VALIDATION_FAILED",
          "Choose your name and a password",
          [
            ...(!body.name ? [{ path: "name", message: "Enter your name" }] : []),
            ...(!password.success
              ? [{ path: "password", message: password.error.issues[0]?.message ?? "Invalid password" }]
              : []),
          ],
        );
      }
      user = await this.prisma.client.user.create({
        data: { email: invite.email, name: body.name, passwordHash: await hashPassword(password.data) },
      });
    }

    const userId = user.id;
    await this.tenantDb.tx(invite.tenantId, async (tx) => {
      const { count } = await tx.invitation.updateMany({
        where: { id: invite.invitationId, acceptedAt: null },
        data: { acceptedAt: new Date() },
      });
      if (!count)
        throw new AppException(
          HttpStatus.NOT_FOUND,
          "NOT_FOUND",
          "This invitation is invalid or has expired",
        );
      await tx.membership.upsert({
        where: { tenantId_userId: { tenantId: invite.tenantId, userId } },
        update: {},
        create: { tenantId: invite.tenantId, userId, roleId: invite.roleId },
      });
      await this.audit.record(
        tx,
        { kind: "system", tenantId: invite.tenantId },
        {
          action: "member.joined",
          entityType: "invitation",
          entityId: invite.invitationId,
          after: { email: invite.email },
          ...requestMeta(req),
        },
      );
    });

    // The invitation went to this address (or a confirmed teammate passed the link on)
    await this.verification.markVerified(userId);
    await this.tokens.issueSession(reply, req, { userId, tenantId: invite.tenantId });
    return this.authService.me(userId, invite.tenantId);
  }
}
