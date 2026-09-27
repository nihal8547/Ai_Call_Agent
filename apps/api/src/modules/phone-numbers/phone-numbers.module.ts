import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { TelephonyModule } from "../telephony/telephony.module";
import { BlockedCallersController } from "./blocked-callers.controller";
import { PhoneNumbersController } from "./phone-numbers.controller";
import { PhoneNumbersService } from "./phone-numbers.service";
import { SipTrunksController } from "./sip-trunks.controller";
import { SipTrunksService } from "./sip-trunks.service";

@Module({
  imports: [AuditModule, TelephonyModule],
  controllers: [PhoneNumbersController, SipTrunksController, BlockedCallersController],
  providers: [PhoneNumbersService, SipTrunksService],
})
export class PhoneNumbersModule {}
