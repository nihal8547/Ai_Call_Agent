import { Global, Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { CrmController } from "./crm.controller";
import { CrmSyncService } from "./crm-sync.service";

/** Lead sync to HubSpot and Zoho CRM, field mapping, and "Connect with …" sign-in */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [CrmController],
  providers: [CrmSyncService],
  exports: [CrmSyncService],
})
export class CrmModule {}
