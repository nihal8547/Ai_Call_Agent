import { Inject, Injectable } from "@nestjs/common";
import { createEmbeddingProvider, type LLMProvider } from "@platform/ai";
import { createKnowledgeRetriever } from "@platform/rag";
import type { KnowledgeRetriever } from "@platform/runtime";
import type { AgentConfig } from "@platform/shared";
import { API_ENV, type ApiEnv } from "../../config/env";
import { PrismaService } from "../../infra/prisma.service";

/** Builds the knowledge retriever an agent uses on a call (or in the test console) */
@Injectable()
export class RetrieverFactory {
  private readonly embeddings;

  constructor(
    @Inject(API_ENV) env: ApiEnv,
    private readonly prisma: PrismaService,
  ) {
    this.embeddings = createEmbeddingProvider(env.EMBEDDINGS_PROVIDER, { gemini: env.GEMINI_API_KEY });
  }

  /** null when the agent has no collections or does not answer questions */
  forAgent(
    ctx: { tenantId: string; agentId: string },
    config: AgentConfig,
    llm: LLMProvider | null,
  ): KnowledgeRetriever | null {
    if (!config.workflow.answerQuestions || !config.knowledge.collectionIds.length) return null;
    return createKnowledgeRetriever({
      prisma: this.prisma.client,
      embeddings: this.embeddings,
      llm,
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      businessName: config.businessName,
      model: config.llm.model,
      knowledge: config.knowledge,
    });
  }
}
