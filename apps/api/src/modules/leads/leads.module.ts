import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { LeadsController } from "./leads.controller";

@Module({ imports: [AuditModule], controllers: [LeadsController] })
export class LeadsModule {}
