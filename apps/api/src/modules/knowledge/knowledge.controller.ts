import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { createEmbeddingProvider } from "@platform/ai";
import type { Document } from "@platform/db";
import { searchKnowledge } from "@platform/rag";
import {
  CreateCollectionBody,
  IdParam,
  KnowledgeSearchBody,
  ListDocumentsQuery,
  UpdateCollectionBody,
  UpdateDocumentBody,
  UploadDocumentFields,
  zodIssuesToFieldErrors,
} from "@platform/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { AppException } from "../../common/filters/problem-details.filter";
import { cursorArgs, toPage } from "../../common/http/pagination";
import { requestMeta } from "../../common/http/request-meta";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { API_ENV, type ApiEnv } from "../../config/env";
import { PrismaService } from "../../infra/prisma.service";
import { StorageService } from "../../infra/storage.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AuditService } from "../audit/audit.service";
import { DocumentsService } from "./documents.service";

const docView = {
  id: true,
  collectionId: true,
  title: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  status: true,
  statusMessage: true,
  progress: true,
  enabled: true,
  version: true,
  replacesId: true,
  pageCount: true,
  chunkCount: true,
  metadata: true,
  processedAt: true,
  createdAt: true,
  agents: { select: { agent: { select: { id: true, name: true } } } },
} as const;

type DocRow = { sizeBytes: bigint; agents: { agent: { id: string; name: string } }[] } & Record<
  string,
  unknown
>;
/** The storage location stays server-side */
const publicDoc = ({ storageKey: _key, sizeBytes, ...doc }: Document) => ({
  ...doc,
  sizeBytes: Number(sizeBytes),
});
const serialize = (d: DocRow) => ({
  ...d,
  sizeBytes: Number(d.sizeBytes),
  agents: d.agents.map((a) => a.agent),
});

@Controller()
export class KnowledgeController {
  private readonly embeddings;

  constructor(
    @Inject(API_ENV) env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDbService,
    private readonly storage: StorageService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
  ) {
    this.embeddings = createEmbeddingProvider(env.EMBEDDINGS_PROVIDER, { gemini: env.GEMINI_API_KEY });
  }

  // ── Collections ──────────────────────────────────────────────────────────
  @RequirePermissions("knowledge:read")
  @Get("knowledge/collections")
  async collections(@CurrentAuth() auth: AuthContext) {
    const rows = await this.tenantDb.db(auth.tenantId).knowledgeCollection.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { documents: true } } },
    });
    return { items: rows.map(({ _count, ...c }) => ({ ...c, documentCount: _count.documents })) };
  }

  @RequirePermissions("knowledge:write")
  @Post("knowledge/collections")
  createCollection(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(CreateCollectionBody)) body: z.output<typeof CreateCollectionBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const c = await tx.knowledgeCollection.create({
        data: {
          tenantId: auth.tenantId,
          name: body.name,
          description: body.description ?? null,
          settings: body.settings,
        },
      });
      await this.audit.record(tx, auth, {
        action: "collection.created",
        entityType: "knowledge_collection",
        entityId: c.id,
        after: body,
        ...requestMeta(req),
      });
      return c;
    });
  }

  @RequirePermissions("knowledge:write")
  @Patch("knowledge/collections/:id")
  updateCollection(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(UpdateCollectionBody)) body: z.output<typeof UpdateCollectionBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      if (!(await tx.knowledgeCollection.count({ where: { id } })))
        throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Collection not found");
      const c = await tx.knowledgeCollection.update({ where: { id }, data: body });
      await this.audit.record(tx, auth, {
        action: "collection.updated",
        entityType: "knowledge_collection",
        entityId: id,
        after: body,
        ...requestMeta(req),
      });
      return c;
    });
  }

  @RequirePermissions("knowledge:write")
  @Delete("knowledge/collections/:id")
  @HttpCode(204)
  async deleteCollection(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Req() req: FastifyRequest,
  ): Promise<void> {
    await this.tenantDb.tx(auth.tenantId, async (tx) => {
      const c = await tx.knowledgeCollection.findUnique({
        where: { id },
        include: { _count: { select: { documents: true } } },
      });
      if (!c) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Collection not found");
      if (c._count.documents)
        throw new AppException(
          HttpStatus.CONFLICT,
          "CONFLICT",
          "Delete the documents in this collection first",
        );
      await tx.knowledgeCollection.delete({ where: { id } });
      await this.audit.record(tx, auth, {
        action: "collection.deleted",
        entityType: "knowledge_collection",
        entityId: id,
        before: { name: c.name },
        ...requestMeta(req),
      });
    });
  }

  // ── Documents ────────────────────────────────────────────────────────────
  @RequirePermissions("knowledge:read")
  @Get("documents")
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(ListDocumentsQuery)) q: z.output<typeof ListDocumentsQuery>,
  ) {
    const rows = await this.tenantDb.db(auth.tenantId).document.findMany({
      where: {
        ...(q.collectionId ? { collectionId: q.collectionId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.q
          ? {
              OR: [
                { title: { contains: q.q, mode: "insensitive" as const } },
                { fileName: { contains: q.q, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
      select: docView,
      ...cursorArgs(q.cursor, q.limit),
    });
    const page = toPage(rows, q.limit);
    return { ...page, items: page.items.map(serialize) };
  }

  /** multipart/form-data: file + collectionId (+ title) */
  @RequirePermissions("knowledge:write")
  @Post("documents")
  async upload(@CurrentAuth() auth: AuthContext, @Req() req: FastifyRequest) {
    const { fields, buffer, fileName } = await readUpload(req);
    const doc = await this.documents.upload(auth, { ...fields, fileName, buffer }, requestMeta(req));
    return publicDoc(doc);
  }

  /** Upload a new version; the old one stays searchable until the new one is ready */
  @RequirePermissions("knowledge:write")
  @Post("documents/:id/replace")
  async replace(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Req() req: FastifyRequest,
  ) {
    const old = await this.tenantDb.db(auth.tenantId).document.findUnique({ where: { id } });
    if (!old) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Document not found");
    if (old.status !== "READY" && old.status !== "FAILED")
      throw new AppException(
        HttpStatus.CONFLICT,
        "CONFLICT",
        "Wait until this document has finished processing",
      );
    const { buffer, fileName, fields } = await readUpload(req, true);
    const doc = await this.documents.upload(
      auth,
      { collectionId: old.collectionId, ...(fields.title ? { title: fields.title } : {}), fileName, buffer },
      requestMeta(req),
      old,
    );
    return publicDoc(doc);
  }

  @RequirePermissions("knowledge:write")
  @Post("documents/:id/reprocess")
  async reprocess(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
  ) {
    const doc = await this.documents.reprocess(auth, id);
    return publicDoc(doc);
  }

  @RequirePermissions("knowledge:read")
  @Get("documents/:id")
  async get(@CurrentAuth() auth: AuthContext, @Param(new ZodValidationPipe(IdParam)) { id }: { id: string }) {
    const db = this.tenantDb.db(auth.tenantId);
    const doc = await db.document.findUnique({ where: { id }, select: docView });
    if (!doc) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Document not found");
    const preview = await db.documentChunk.findMany({
      where: { documentId: id },
      orderBy: { ordinal: "asc" },
      take: 5,
      select: { ordinal: true, content: true, metadata: true, tokenCount: true },
    });
    return { ...serialize(doc), preview };
  }

  @RequirePermissions("knowledge:read")
  @Get("documents/:id/download")
  async download(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Res() reply: FastifyReply,
  ) {
    const doc = await this.tenantDb.db(auth.tenantId).document.findUnique({ where: { id } });
    if (!doc) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Document not found");
    const body = await this.storage.storage.get(doc.storageKey);
    const safeName = doc.fileName.replace(/[^\w.\- ]+/g, "_");
    void reply
      .header("content-type", doc.mimeType)
      .header("content-disposition", `attachment; filename="${safeName}"`)
      .header("x-content-type-options", "nosniff")
      .send(body);
  }

  @RequirePermissions("knowledge:write")
  @Patch("documents/:id")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(UpdateDocumentBody)) body: z.output<typeof UpdateDocumentBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      if (!(await tx.document.count({ where: { id } })))
        throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Document not found");
      if (body.agentIds) {
        const found = await tx.agent.count({ where: { id: { in: body.agentIds } } });
        if (found !== new Set(body.agentIds).size) {
          throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Unknown agent", [
            { path: "agentIds", message: "Unknown agent" },
          ]);
        }
        await tx.documentAgent.deleteMany({ where: { documentId: id } });
        if (body.agentIds.length)
          await tx.documentAgent.createMany({
            data: [...new Set(body.agentIds)].map((agentId) => ({
              tenantId: auth.tenantId,
              documentId: id,
              agentId,
            })),
          });
      }
      const { agentIds: _a, ...fields } = body;
      if (Object.keys(fields).length) await tx.document.update({ where: { id }, data: fields });
      await this.audit.record(tx, auth, {
        action: "document.updated",
        entityType: "document",
        entityId: id,
        after: body,
        ...requestMeta(req),
      });
      return serialize((await tx.document.findUniqueOrThrow({ where: { id }, select: docView })) as DocRow);
    });
  }

  @RequirePermissions("knowledge:write")
  @Delete("documents/:id")
  @HttpCode(204)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Req() req: FastifyRequest,
  ): Promise<void> {
    await this.documents.remove(auth, id, requestMeta(req));
  }

  // ── Search playground ────────────────────────────────────────────────────
  @RequirePermissions("knowledge:read")
  @Post("knowledge/search")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  search(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(KnowledgeSearchBody)) body: z.output<typeof KnowledgeSearchBody>,
  ) {
    return searchKnowledge(this.prisma.client, this.embeddings, {
      tenantId: auth.tenantId,
      query: body.query,
      topK: body.topK,
      ...(body.collectionIds ? { collectionIds: body.collectionIds } : {}),
      ...(body.agentId ? { agentId: body.agentId } : {}),
    });
  }
}

/** Read the single file and its form fields from a multipart request */
async function readUpload(req: FastifyRequest, fieldsOptional = false) {
  if (!req.isMultipart())
    throw new AppException(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      "UNSUPPORTED_MEDIA_TYPE",
      "Send the file as multipart/form-data",
    );
  const file = await req.file();
  if (!file)
    throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "No file was uploaded", [
      { path: "file", message: "Choose a file" },
    ]);
  const buffer = await file.toBuffer(); // enforces the size limit (413)
  const raw = Object.fromEntries(
    Object.entries(file.fields)
      .filter(([k]) => k !== file.fieldname)
      .map(([k, v]) => [
        k,
        v && typeof v === "object" && "value" in v ? (v as { value: unknown }).value : undefined,
      ]),
  );
  const parsed = (fieldsOptional ? UploadDocumentFields.partial() : UploadDocumentFields).safeParse(raw);
  if (!parsed.success)
    throw new AppException(
      HttpStatus.BAD_REQUEST,
      "VALIDATION_FAILED",
      "Invalid upload",
      zodIssuesToFieldErrors(parsed.error.issues),
    );
  if (!buffer.length)
    throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "The file is empty", [
      { path: "file", message: "The file is empty" },
    ]);
  return {
    buffer,
    fileName: file.filename || "upload",
    fields: parsed.data as z.output<typeof UploadDocumentFields>,
  };
}
