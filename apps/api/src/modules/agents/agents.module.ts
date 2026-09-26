import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AgentsController } from "./agents.controller";

@Module({ imports: [AuditModule], controllers: [AgentsController] })
export class AgentsModule {}
