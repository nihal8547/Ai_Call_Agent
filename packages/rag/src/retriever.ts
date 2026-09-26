import type { EmbeddingProvider, LLMProvider } from "@platform/ai";
import type { PrismaClient } from "@platform/db";
import {
  answerFromPassages,
  type AnswerFailure,
  type GroundedAnswer,
  type Passage,
  relevantPassages,
} from "./answer";
import { searchKnowledge, type SearchHit } from "./retrieve";

/** What a search found, before any answer is attempted */
export type KnowledgeSearch = {
  query: string;
  mode: "hybrid" | "keyword" | "none";
  /** Candidates as ranked (for the timeline), and which passed the relevance gate */
  hits: (Pick<
    SearchHit,
    "chunkId" | "documentId" | "documentTitle" | "score" | "vectorScore" | "textScore"
  > & {
    relevant: boolean;
  })[];
  passages: Passage[];
  latencyMs: number;
  /** Why nothing can be answered from knowledge */
  reason?: "no_collections" | "no_hits" | "not_relevant" | "error";
};

export type KnowledgeAnswerResult = {
  answer: GroundedAnswer | null;
  failure?: AnswerFailure | KnowledgeSearch["reason"];
  detail?: string;
  llmMs?: number;
  /** Chunk ids given to the answer step */
  usedChunkIds: string[];
};

export type RetrieverDeps = {
  prisma: PrismaClient;
  embeddings: EmbeddingProvider | null;
  llm: LLMProvider | null;
  tenantId: string;
  agentId: string;
  businessName: string;
  model: string;
  knowledge: { collectionIds: string[]; topK: number; minScore: number };
};

/**
 * Knowledge access for one agent on one call: only its collections, only documents it may use,
 * and answers that are grounded in what was found (or none at all).
 */
export function createKnowledgeRetriever(deps: RetrieverDeps) {
  const { knowledge } = deps;

  async function search(query: string, opts: { timeoutMs: number }): Promise<KnowledgeSearch> {
    const started = Date.now();
    const empty = (
      reason: KnowledgeSearch["reason"],
      mode: KnowledgeSearch["mode"] = "none",
    ): KnowledgeSearch => ({
      query,
      mode,
      hits: [],
      passages: [],
      latencyMs: Date.now() - started,
      ...(reason ? { reason } : {}),
    });
    if (!knowledge.collectionIds.length) return empty("no_collections");
    try {
      const r = await searchKnowledge(deps.prisma, deps.embeddings, {
        tenantId: deps.tenantId,
        agentId: deps.agentId,
        collectionIds: knowledge.collectionIds,
        query,
        topK: Math.max(knowledge.topK * 2, 8),
        // Leave most of the time for the database; fall back to keywords if embedding is slow
        embedTimeoutMs: Math.max(200, Math.floor(opts.timeoutMs * 0.6)),
      });
      const passages = relevantPassages(query, r.hits, {
        minScore: knowledge.minScore,
        topK: knowledge.topK,
      });
      const relevant = new Set(passages.map((p) => p.chunkId));
      return {
        query,
        mode: r.mode,
        hits: r.hits.map((h) => ({
          chunkId: h.chunkId,
          documentId: h.documentId,
          documentTitle: h.documentTitle,
          score: h.score,
          vectorScore: h.vectorScore,
          textScore: h.textScore,
          relevant: relevant.has(h.chunkId),
        })),
        passages,
        latencyMs: Date.now() - started,
        ...(r.hits.length
          ? passages.length
            ? {}
            : { reason: "not_relevant" as const }
          : { reason: "no_hits" as const }),
      };
    } catch {
      return empty("error");
    }
  }

  async function answer(
    question: string,
    found: KnowledgeSearch,
    opts: { timeoutMs: number },
  ): Promise<KnowledgeAnswerResult> {
    if (!found.passages.length) return { answer: null, failure: found.reason ?? "no_hits", usedChunkIds: [] };
    const r = await answerFromPassages(
      { llm: deps.llm, model: deps.model, businessName: deps.businessName },
      question,
      found.passages,
      opts,
    );
    return {
      answer: r.answer,
      ...(r.failure ? { failure: r.failure } : {}),
      ...(r.detail ? { detail: r.detail } : {}),
      ...(r.llmMs !== undefined ? { llmMs: r.llmMs } : {}),
      usedChunkIds: r.used.map((p) => p.chunkId),
    };
  }

  return { search, answer };
}

export type KnowledgeRetrieverImpl = ReturnType<typeof createKnowledgeRetriever>;
