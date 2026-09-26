import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AppointmentsController } from "./appointments.controller";

@Module({ imports: [AuditModule], controllers: [AppointmentsController] })
export class AppointmentsModule {}
