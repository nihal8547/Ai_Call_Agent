import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { DocumentsService } from "./documents.service";
import { KnowledgeGapsController } from "./gaps.controller";
import { KnowledgeController } from "./knowledge.controller";
import { RetrieverFactory } from "./retriever.factory";

@Module({
  imports: [AuditModule],
  controllers: [KnowledgeController, KnowledgeGapsController],
  providers: [DocumentsService, RetrieverFactory],
  exports: [RetrieverFactory, DocumentsService],
})
export class KnowledgeModule {}
