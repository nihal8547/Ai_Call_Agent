import type { EmbeddingProvider } from "@platform/ai";
import { Prisma, type PrismaClient, withTenant } from "@platform/db";
import { contentWords, variants } from "./lexicon";

export type SearchHit = {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  metadata: Record<string, unknown>;
  /** Cosine similarity 0–1 (null when found by keywords only) */
  vectorScore: number | null;
  /** Full-text rank (null when found by meaning only) */
  textScore: number | null;
  /** Reciprocal-rank-fusion score used for ordering */
  score: number;
};

export type SearchParams = {
  tenantId: string;
  query: string;
  /** Limit to these collections; omit to search every collection */
  collectionIds?: string[];
  /** Respect documents restricted to specific agents */
  agentId?: string;
  topK?: number;
  /** Time allowed for embedding the query; on timeout the search continues with keywords only */
  embedTimeoutMs?: number;
};

const CANDIDATES = 30;
const EF_SEARCH = 100;

let iterativeScan: Promise<boolean> | null = null;
/** hnsw.iterative_scan exists from pgvector 0.8.0 (checked once per process) */
function supportsIterativeScan(prisma: PrismaClient): Promise<boolean> {
  iterativeScan ??= prisma.$queryRaw<
    { v: string }[]
  >`SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`
    .then((rows) => {
      const [major = 0, minor = 0] = (rows[0]?.v ?? "0").split(".").map(Number);
      return major > 0 || minor >= 8;
    })
    .catch(() => false);
  return iterativeScan;
}
const RRF_K = 60;

/** Prefix-matching OR query of the meaningful words and their synonyms ("villas in Baner?" → villa:* | baner:*) */
export function toTsQuery(query: string): string | null {
  const words = contentWords(query).slice(0, 12);
  const terms = [...new Set(words.flatMap(variants))]
    .map((w) => w.replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter(Boolean)
    .slice(0, 40);
  return terms.length ? terms.map((w) => `${w}:*`).join(" | ") : null;
}

/**
 * Hybrid search over a tenant's knowledge: semantic (pgvector cosine) and keyword (Postgres full-text)
 * candidates fused with reciprocal rank fusion. Works with keywords alone when no embeddings exist.
 * Row-Level Security confines everything to the tenant; filters add collection, enabled/ready and agent rules.
 */
export async function searchKnowledge(
  prisma: PrismaClient,
  embeddings: EmbeddingProvider | null,
  p: SearchParams,
): Promise<{
  hits: SearchHit[];
  mode: "hybrid" | "keyword";
  /** Tokens embedded for the query (usage metering) */
  embedUsage?: { model: string; inputTokens: number };
}> {
  const topK = p.topK ?? 5;
  let queryVector: number[] | null = null;
  let embedUsage: { model: string; inputTokens: number } | undefined;
  if (embeddings) {
    const r = await embeddings.embed([p.query], { kind: "query", timeoutMs: p.embedTimeoutMs ?? 1500 });
    if (r.ok) {
      queryVector = r.vectors[0] ?? null;
      embedUsage = { model: r.model, inputTokens: r.usage.inputTokens };
    }
  }
  const tsq = toTsQuery(p.query);

  const filters = Prisma.sql`
    d.enabled AND d.status = 'READY'
    ${p.collectionIds ? Prisma.sql`AND c.collection_id = ANY(${p.collectionIds}::uuid[])` : Prisma.empty}
    ${
      p.agentId
        ? Prisma.sql`AND (NOT EXISTS (SELECT 1 FROM document_agents da WHERE da.document_id = d.id)
               OR EXISTS (SELECT 1 FROM document_agents da WHERE da.document_id = d.id AND da.agent_id = ${p.agentId}::uuid))`
        : Prisma.empty
    }`;

  type Row = {
    id: string;
    document_id: string;
    title: string;
    content: string;
    metadata: Record<string, unknown>;
    score: number;
  };

  const iterative = queryVector ? await supportsIterativeScan(prisma) : false;
  const [vectorRows, textRows] = await withTenant(prisma, p.tenantId, async (tx) => {
    if (queryVector) {
      // Filters are applied after the HNSW scan: search wider, and (pgvector ≥ 0.8) keep scanning
      // until enough rows pass the tenant/collection/agent filters
      await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${EF_SEARCH}`);
      if (iterative) await tx.$executeRawUnsafe(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    }
    const vec = queryVector
      ? await tx.$queryRaw<Row[]>`
          SELECT c.id, c.document_id, d.title, c.content, c.metadata, (1 - (c.embedding <=> ${`[${queryVector.join(",")}]`}::vector))::float AS score
          FROM document_chunks c JOIN documents d ON d.id = c.document_id
          WHERE c.embedding IS NOT NULL AND c.embedding_model = ${embeddings!.model} AND ${filters}
          ORDER BY c.embedding <=> ${`[${queryVector.join(",")}]`}::vector
          LIMIT ${CANDIDATES}`
      : [];
    const txt = tsq
      ? await tx.$queryRaw<Row[]>`
          SELECT c.id, c.document_id, d.title, c.content, c.metadata, ts_rank_cd(c.search_vector, to_tsquery('simple', ${tsq}))::float AS score
          FROM document_chunks c JOIN documents d ON d.id = c.document_id
          WHERE c.search_vector @@ to_tsquery('simple', ${tsq}) AND ${filters}
          ORDER BY score DESC
          LIMIT ${CANDIDATES}`
      : [];
    return [vec, txt] as const;
  });

  const hits = new Map<string, SearchHit>();
  const add = (rows: readonly Row[], kind: "vector" | "text") =>
    rows.forEach((r, rank) => {
      const hit = hits.get(r.id) ?? {
        chunkId: r.id,
        documentId: r.document_id,
        documentTitle: r.title,
        content: r.content,
        metadata: r.metadata,
        vectorScore: null,
        textScore: null,
        score: 0,
      };
      if (kind === "vector") hit.vectorScore = r.score;
      else hit.textScore = r.score;
      hit.score += 1 / (RRF_K + rank + 1);
      hits.set(r.id, hit);
    });
  add(vectorRows, "vector");
  add(textRows, "text");

  return {
    hits: [...hits.values()].sort((a, b) => b.score - a.score).slice(0, topK),
    mode: queryVector ? "hybrid" : "keyword",
    ...(embedUsage ? { embedUsage } : {}),
  };
}
