import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { PhoneNumbersController } from "./phone-numbers.controller";

@Module({ imports: [AuditModule], controllers: [PhoneNumbersController] })
export class PhoneNumbersModule {}
