import { Body, Controller, Get, HttpStatus, Post, Query, Req } from "@nestjs/common";
import { Prisma } from "@platform/db";
import { CreateFaqBody, KnowledgeGapsQuery } from "@platform/shared";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { AppException } from "../../common/filters/problem-details.filter";
import { requestMeta } from "../../common/http/request-meta";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TenantDbService } from "../../infra/tenant-db.service";
import { DocumentsService } from "./documents.service";
import { gapKey, groupGaps } from "./gaps";

const MAX_QUESTIONS = 2000;

/** Questions callers asked that the knowledge base could not answer, and filling them in */
@Controller()
export class KnowledgeGapsController {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly documents: DocumentsService,
  ) {}

  /** Callers' own words are shown, so this needs transcript access as well as knowledge access */
  @RequirePermissions("knowledge:read", "calls:read_transcript")
  @Get("knowledge/gaps")
  async gaps(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(KnowledgeGapsQuery)) q: z.output<typeof KnowledgeGapsQuery>,
  ) {
    const since = new Date(Date.now() - q.days * 86_400_000);
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<
        { question: string; reason: string | null; call_id: string; created_at: Date }[]
      >`
        SELECT e.payload->>'question' AS question, e.payload->>'reason' AS reason, e.call_id, e.created_at
        FROM call_events e
        ${q.agentId ? Prisma.sql`JOIN calls c ON c.id = e.call_id AND c.agent_id = ${q.agentId}::uuid` : Prisma.empty}
        WHERE e.type = 'RAG_RETRIEVAL' AND e.payload->>'answered' = 'safe'
          AND e.payload->>'question' IS NOT NULL AND e.created_at >= ${since}
        ORDER BY e.created_at DESC
        LIMIT ${MAX_QUESTIONS}`;
      // Gaps already answered with "Add to FAQ" disappear from the report
      const resolved = await tx.$queryRaw<{ key: string }[]>`
        SELECT DISTINCT metadata->>'faqGapKey' AS key FROM documents WHERE metadata ? 'faqGapKey'`;
      const items = groupGaps(
        rows.map((r) => ({ question: r.question, reason: r.reason, callId: r.call_id, at: r.created_at })),
        new Set(resolved.map((r) => r.key)),
      );
      return { items, days: q.days, questions: rows.length };
    });
  }

  /** Turn an answer into a small document; it is searchable as soon as it is processed */
  @RequirePermissions("knowledge:write")
  @Post("knowledge/faq")
  async addFaq(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(CreateFaqBody)) body: z.output<typeof CreateFaqBody>,
    @Req() req: FastifyRequest,
  ) {
    const question = body.question.replace(/\s+/g, " ").replace(/[?.!\s]*$/, "?");
    const text = `# ${question}\n\n${body.answer.trim()}\n`;
    const slug = gapKey(question).replace(/\s+/g, "-").slice(0, 60) || "question";
    try {
      const doc = await this.documents.upload(
        auth,
        {
          collectionId: body.collectionId,
          title: `FAQ: ${question}`.slice(0, 200),
          fileName: `faq-${slug}.md`,
          buffer: Buffer.from(text, "utf8"),
          metadata: { source: "faq", faqGapKey: body.gapKey ?? gapKey(question) },
        },
        requestMeta(req),
      );
      return { ...doc, sizeBytes: Number(doc.sizeBytes), storageKey: undefined };
    } catch (err) {
      if (err instanceof AppException && err.getStatus() === HttpStatus.CONFLICT)
        throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "This answer is already in the collection");
      throw err;
    }
  }
}
