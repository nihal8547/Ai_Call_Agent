import { Global, Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { TelephonyModule } from "../telephony/telephony.module";
import { DeadLetterService } from "./dead-letter.service";
import { FailedJobsController } from "./failed-jobs.controller";
import { JobProcessors } from "./job-processors.service";
import { QueueConsumers } from "./queue-consumers.service";

/** Call-side background jobs: consumers, the failed-jobs list, and the processors other modules extend */
@Global()
@Module({
  imports: [AuditModule, TelephonyModule],
  controllers: [FailedJobsController],
  providers: [JobProcessors, DeadLetterService, QueueConsumers],
  exports: [JobProcessors],
})
export class JobsModule {}
