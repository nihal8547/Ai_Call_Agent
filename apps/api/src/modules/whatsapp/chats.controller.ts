import { Controller, Get, Param, Post, Body } from "@nestjs/common";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import type { AuthContext } from "../../common/auth/auth.types";
import { TenantDbService } from "../../infra/tenant-db.service";

@Controller("chats")
export class ChatsController {
  constructor(private readonly tenantDb: TenantDbService) {}

  @RequirePermissions("calls:read")
  @Get()
  async listChats(@CurrentAuth() auth: AuthContext) {
    const db = this.tenantDb.db(auth.tenantId) as any;
    const sessions = await db.chatSession.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1, // Get latest message for preview
        },
      },
    });

    return {
      items: sessions.map((s: any) => ({
        id: s.id,
        customerNumber: s.customerNumber,
        status: s.status,
        latestMessage: s.messages[0]?.content || "",
        updatedAt: s.messages[0]?.createdAt || s.createdAt,
      })),
    };
  }

  @RequirePermissions("calls:read")
  @Get(":id/messages")
  async getMessages(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    const db = this.tenantDb.db(auth.tenantId) as any;
    const session = await db.chatSession.findUnique({
      where: { id },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!session) {
      throw new Error("Chat not found");
    }

    return {
      items: session.messages,
    };
  }

  @RequirePermissions("calls:read")
  @Post(":id/messages")
  async sendMessage(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: { content: string }
  ) {
    const db = this.tenantDb.db(auth.tenantId) as any;
    
    // Create outbound message
    const message = await db.chatMessage.create({
      data: {
        sessionId: id,
        direction: "OUTBOUND",
        type: "TEXT",
        content: body.content,
      },
    });

    // TODO: Send to Meta API
    // await this.whatsappService.sendMessage(...)

    return message;
  }
}
