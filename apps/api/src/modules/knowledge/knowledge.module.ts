import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { DocumentsService } from "./documents.service";
import { KnowledgeController } from "./knowledge.controller";

@Module({ imports: [AuditModule], controllers: [KnowledgeController], providers: [DocumentsService] })
export class KnowledgeModule {}
