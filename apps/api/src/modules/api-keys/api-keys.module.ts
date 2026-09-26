import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { ApiKeysController } from "./api-keys.controller";

@Module({ imports: [AuditModule], controllers: [ApiKeysController] })
export class ApiKeysModule {}
