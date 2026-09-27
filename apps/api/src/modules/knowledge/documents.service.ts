import { HttpStatus, Injectable } from "@nestjs/common";
import { sha256Hex } from "@platform/crypto";
import { type Document, Prisma, readJson, type TenantTx } from "@platform/db";
import { detectFileKind, MIME } from "@platform/rag";
import { TenantLimits } from "@platform/shared";
import { documentKey } from "@platform/storage";
import { randomUUID } from "node:crypto";
import type { AuthContext } from "../../common/auth/auth.types";
import { AppException } from "../../common/filters/problem-details.filter";
import { QueueService } from "../../infra/queue.service";
import { StorageService } from "../../infra/storage.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AlertsService } from "../alerts/alerts.service";
import { AuditService } from "../audit/audit.service";

export type UploadInput = {
  collectionId: string;
  title?: string;
  fileName: string;
  buffer: Buffer;
  /** Extra, non-secret facts kept with the document (e.g. which knowledge gap an FAQ answers) */
  metadata?: Record<string, string>;
};

const MB = 1024 * 1024;

@Injectable()
export class DocumentsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly storage: StorageService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly alerts: AlertsService,
  ) {}

  /** A plan limit stopped an upload: the owner hears about it once per month */
  private async limitReached(tenantId: string, what: string, message: string): Promise<never> {
    await this.alerts
      .raise(tenantId, {
        kind: "usage_limit",
        dedupeKey: `${what}-${new Date().toISOString().slice(0, 7)}`,
        message: `Uploads are being refused: ${message.charAt(0).toLowerCase()}${message.slice(1)}.`,
        data: { limit: what },
      })
      .catch(() => undefined);
    throw new AppException(HttpStatus.FORBIDDEN, "USAGE_LIMIT_EXCEEDED", message);
  }

  /** Validate, store and queue a new document (or a new version replacing `replaces`) */
  async upload(
    auth: AuthContext,
    input: UploadInput,
    meta: { ip?: string; userAgent?: string },
    replaces?: Document,
  ): Promise<Document> {
    const kind = detectFileKind(input.buffer, input.fileName);
    if (!kind) {
      throw new AppException(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        "UNSUPPORTED_MEDIA_TYPE",
        "Upload a PDF, Word (.docx), Excel (.xlsx), CSV, text, Markdown, PNG, JPEG or WebP file",
      );
    }
    const checksum = sha256Hex(input.buffer);
    const id = randomUUID();
    const version = replaces ? replaces.version + 1 : 1;
    const storageKey = documentKey(auth.tenantId, id, version, input.fileName);

    await this.tenantDb.tx(auth.tenantId, async (tx) => {
      const collection = await tx.knowledgeCollection.findUnique({ where: { id: input.collectionId } });
      if (!collection)
        throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Unknown collection", [
          { path: "collectionId", message: "Unknown collection" },
        ]);
      await this.assertWithinLimits(tx, auth.tenantId, input.buffer.length, Boolean(replaces));
      const duplicate = await tx.document.findFirst({
        where: { collectionId: input.collectionId, checksum },
        select: { id: true, title: true },
      });
      if (duplicate)
        throw new AppException(
          HttpStatus.CONFLICT,
          "CONFLICT",
          `This file is already in the collection as "${duplicate.title}"`,
        );

      const created = await tx.document.create({
        data: {
          id,
          tenantId: auth.tenantId,
          collectionId: input.collectionId,
          title: input.title ?? replaces?.title ?? titleFrom(input.fileName),
          fileName: input.fileName.slice(0, 255),
          mimeType: MIME[kind],
          sizeBytes: BigInt(input.buffer.length),
          storageKey,
          checksum,
          status: "UPLOADING",
          enabled: replaces?.enabled ?? true,
          version,
          replacesId: replaces?.id ?? null,
          uploadedById: auth.kind === "user" ? auth.userId : null,
          metadata: { ...(input.metadata ?? {}), kind },
        },
      });
      if (replaces) {
        const links = await tx.documentAgent.findMany({ where: { documentId: replaces.id } });
        if (links.length)
          await tx.documentAgent.createMany({
            data: links.map((l) => ({ tenantId: auth.tenantId, documentId: id, agentId: l.agentId })),
          });
      }
      await this.audit.record(tx, auth, {
        action: replaces ? "document.replaced" : "document.uploaded",
        entityType: "document",
        entityId: id,
        after: {
          fileName: input.fileName,
          size: input.buffer.length,
          kind,
          ...(replaces ? { replaces: replaces.id } : {}),
        },
        ...meta,
      });
      return created;
    });

    try {
      await this.storage.storage.put(storageKey, input.buffer, MIME[kind]);
    } catch {
      await this.tenantDb.db(auth.tenantId).document.update({
        where: { id },
        data: { status: "FAILED", statusMessage: "The file could not be stored. Please try again." },
      });
      throw new AppException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "SERVICE_UNAVAILABLE",
        "The file could not be stored. Please try again.",
      );
    }
    const queued = await this.tenantDb
      .db(auth.tenantId)
      .document.update({ where: { id }, data: { status: "PROCESSING", progress: 5 } });
    await this.queue.enqueueIngestion({ tenantId: auth.tenantId, documentId: id }, "v1");
    return queued;
  }

  /** Run the pipeline again (after a failure, or after an embedding provider was added) */
  async reprocess(auth: AuthContext, id: string): Promise<Document> {
    const doc = await this.tenantDb.db(auth.tenantId).document.findUnique({ where: { id } });
    if (!doc) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Document not found");
    if (!["READY", "FAILED"].includes(doc.status))
      throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "This document is already being processed");
    const updated = await this.tenantDb
      .db(auth.tenantId)
      .document.update({ where: { id }, data: { status: "PROCESSING", progress: 5, statusMessage: null } });
    await this.queue.enqueueIngestion({ tenantId: auth.tenantId, documentId: id }, `r${Date.now()}`);
    return updated;
  }

  async remove(auth: AuthContext, id: string, meta: { ip?: string; userAgent?: string }): Promise<void> {
    const key = await this.tenantDb.tx(auth.tenantId, async (tx) => {
      const doc = await tx.document.findUnique({ where: { id } });
      if (!doc) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Document not found");
      // A pending replacement no longer has anything to replace
      await tx.document.updateMany({ where: { replacesId: id }, data: { replacesId: null } });
      await tx.document.delete({ where: { id } });
      await this.audit.record(tx, auth, {
        action: "document.deleted",
        entityType: "document",
        entityId: id,
        before: { title: doc.title, fileName: doc.fileName },
        ...meta,
      });
      return doc.storageKey;
    });
    await this.storage.storage.delete(key).catch(() => undefined);
  }

  private async assertWithinLimits(
    tx: TenantTx,
    tenantId: string,
    size: number,
    isReplacement: boolean,
  ): Promise<void> {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { usageLimits: true },
    });
    const limits = readJson(TenantLimits, tenant.usageLimits, "tenants.usage_limits");
    if (size > limits.maxDocumentSizeMb * MB) {
      throw new AppException(
        HttpStatus.PAYLOAD_TOO_LARGE,
        "PAYLOAD_TOO_LARGE",
        `Files can be up to ${limits.maxDocumentSizeMb} MB on your plan`,
      );
    }
    const [{ count, bytes }] = (await tx.$queryRaw<{ count: bigint; bytes: bigint | null }[]>(
      Prisma.sql`SELECT count(*) AS count, sum(size_bytes) AS bytes FROM documents`,
    )) as [{ count: bigint; bytes: bigint | null }];
    if (!isReplacement && Number(count) >= limits.maxDocuments)
      await this.limitReached(tenantId, "maxDocuments", `Your plan allows ${limits.maxDocuments} documents`);
    if (Number(bytes ?? 0n) + size > limits.maxStorageMb * MB)
      await this.limitReached(
        tenantId,
        "maxStorageMb",
        `Your plan allows ${limits.maxStorageMb} MB of documents`,
      );
  }
}

function titleFrom(fileName: string): string {
  const base = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return (base || "Untitled document").slice(0, 200);
}
