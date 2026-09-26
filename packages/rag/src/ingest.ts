import type { EmbeddingProvider } from "@platform/ai";
import { Prisma, type PrismaClient, type TenantTx, withTenant } from "@platform/db";
import { costMicros, DEFAULT_PRICES, mergeUsage, type PriceTable, type UsageLine } from "@platform/shared";
import type { ObjectStorage } from "@platform/storage";
import { chunkBlocks } from "./chunk";
import { cleanBlocks } from "./clean";
import { detectFileKind } from "./detect";
import { extract, type OcrProvider } from "./extract";
import { type Chunk, DocumentError } from "./types";

export type IngestDeps = {
  prisma: PrismaClient;
  storage: ObjectStorage;
  /** null = no embedding provider: the document is searchable by keywords only */
  embeddings: EmbeddingProvider | null;
  ocr: OcrProvider | null;
  /** Unit prices for usage cost estimates (defaults: list prices) */
  prices?: PriceTable;
};

/** Temporary failure (provider outage, rate limit): the job should be retried */
export class TransientIngestError extends Error {}

const EMBED_BATCH = 96;
const INSERT_BATCH = 200;

/**
 * Turn an uploaded document into searchable chunks:
 * extracting → (OCR) → clean → chunk → embedding → store → READY.
 * Safe to run again (reprocess/retry): the document's chunks are replaced atomically.
 * When the document replaces an older version, the old one is removed only once this one is READY.
 */
export async function ingestDocument(
  deps: IngestDeps,
  job: { tenantId: string; documentId: string },
): Promise<"ready" | "failed" | "skipped"> {
  const { prisma } = deps;
  const tenant = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(prisma, job.tenantId, fn);
  const doc = await tenant((tx) =>
    tx.document.findUnique({ where: { id: job.documentId }, include: { collection: true } }),
  );
  if (!doc || doc.status === "READY") return "skipped";

  const setStatus = (
    status: "EXTRACTING" | "EMBEDDING",
    progress: number,
    statusMessage: string | null = null,
  ) =>
    tenant((tx) => tx.document.update({ where: { id: doc.id }, data: { status, progress, statusMessage } }));

  try {
    await setStatus("EXTRACTING", 10);
    const buf = await deps.storage.get(doc.storageKey);
    const kind = detectFileKind(buf, doc.fileName);
    if (!kind) throw new DocumentError("This file type is not supported.");
    const usage: UsageLine[] = [];
    const extraction = await extract(kind, buf, deps.ocr, (u) => {
      usage.push({ kind: "LLM_INPUT_TOKENS", quantity: u.inputTokens, provider: "gemini", model: u.model });
      usage.push({ kind: "LLM_OUTPUT_TOKENS", quantity: u.outputTokens, provider: "gemini", model: u.model });
    });
    const blocks = cleanBlocks(extraction.blocks);
    if (!blocks.some((b) => b.kind !== "heading"))
      throw new DocumentError("No readable text was found in this file.");

    const settings = (doc.collection.settings ?? {}) as { targetTokens?: number; overlapTokens?: number };
    const chunks = chunkBlocks(blocks, {
      ...(settings.targetTokens ? { targetTokens: settings.targetTokens } : {}),
      ...(settings.overlapTokens ? { overlapTokens: settings.overlapTokens } : {}),
    });

    await setStatus("EMBEDDING", 40);
    const embedder = deps.embeddings;
    const vectors = embedder
      ? await embedAll(
          embedder,
          chunks,
          (p) => setStatus("EMBEDDING", 40 + Math.round(p * 50)),
          (tokens, model) =>
            usage.push({ kind: "EMBEDDING_TOKENS", quantity: tokens, provider: model.split("-")[0]!, model }),
        )
      : null;

    const oldStorageKey = await tenant(async (tx) => {
      await tx.documentChunk.deleteMany({ where: { documentId: doc.id } });
      for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
        const rows = chunks.slice(i, i + INSERT_BATCH).map((c, j) => {
          const vec = vectors ? `[${vectors[i + j]!.join(",")}]` : null;
          return Prisma.sql`(gen_random_uuid(), ${job.tenantId}::uuid, ${doc.collectionId}::uuid, ${doc.id}::uuid, ${i + j}, ${c.content}, ${c.tokenCount}, ${JSON.stringify(c.metadata)}::jsonb, ${vec}::vector, ${deps.embeddings?.model ?? "none"})`;
        });
        await tx.$executeRaw`
          INSERT INTO document_chunks (id, tenant_id, collection_id, document_id, ordinal, content, token_count, metadata, embedding, embedding_model)
          VALUES ${Prisma.join(rows)}`;
      }
      await tx.document.update({
        where: { id: doc.id },
        data: {
          status: "READY",
          progress: 100,
          statusMessage: vectors ? null : "Searchable by keywords only (no embedding provider configured)",
          chunkCount: chunks.length,
          pageCount: extraction.pageCount ?? null,
          processedAt: new Date(),
          metadata: {
            ...(doc.metadata as object),
            kind,
            ocr: extraction.needsOcr,
            embedded: Boolean(vectors),
            embeddingModel: deps.embeddings?.model ?? null,
          },
        },
      });
      // What processing this document consumed, with its estimated cost
      const prices = deps.prices ?? DEFAULT_PRICES;
      const lines = mergeUsage(usage);
      if (lines.length)
        await tx.usageRecord.createMany({
          data: lines.map((l) => ({
            tenantId: job.tenantId,
            kind: l.kind,
            quantity: BigInt(Math.round(l.quantity)),
            costMicros: costMicros(prices, l.kind, l.quantity, l.model),
            provider: l.provider.slice(0, 40),
            model: l.model?.slice(0, 80) ?? null,
          })),
        });
      if (!doc.replacesId) return null;
      const old = await tx.document.findUnique({ where: { id: doc.replacesId } });
      if (!old) return null;
      await tx.document.delete({ where: { id: old.id } }); // chunks and agent links cascade
      return old.storageKey;
    });
    if (oldStorageKey) await deps.storage.delete(oldStorageKey).catch(() => undefined);
    return "ready";
  } catch (err) {
    if (err instanceof DocumentError) {
      await markFailed(prisma, job.tenantId, doc.id, err.message);
      return "failed";
    }
    throw err;
  }
}

export async function markFailed(
  prisma: PrismaClient,
  tenantId: string,
  documentId: string,
  message: string,
): Promise<void> {
  await withTenant(prisma, tenantId, (tx) =>
    tx.document.updateMany({
      where: { id: documentId, status: { not: "READY" } },
      data: { status: "FAILED", statusMessage: message.slice(0, 500), progress: 0 },
    }),
  );
}

async function embedAll(
  embeddings: EmbeddingProvider,
  chunks: Chunk[],
  progress: (fraction: number) => Promise<unknown>,
  onUsage: (tokens: number, model: string) => void,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const r = await embeddings.embed(
      chunks.slice(i, i + EMBED_BATCH).map((c) => c.content),
      { kind: "document", timeoutMs: 60_000 },
    );
    if (!r.ok) {
      if (r.error === "auth" || r.error === "invalid_output")
        throw new DocumentError(`The embedding provider rejected the request (${r.error}).`);
      throw new TransientIngestError(`Embedding failed: ${r.error}`);
    }
    out.push(...r.vectors);
    onUsage(r.usage.inputTokens, r.model);
    await progress(out.length / chunks.length);
  }
  return out;
}
