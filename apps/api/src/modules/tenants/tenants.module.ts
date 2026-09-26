import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { TenantsController } from "./tenants.controller";

@Module({ imports: [AuditModule], controllers: [TenantsController] })
export class TenantsModule {}
