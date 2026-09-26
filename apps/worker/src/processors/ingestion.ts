import type { IngestionJob } from "@platform/shared";
import { ingestDocument, type IngestDeps, markFailed } from "@platform/rag";
import type { Job } from "bullmq";
import type { Logger } from "pino";
import { z } from "zod";

const Payload = z.object({ tenantId: z.uuid(), documentId: z.uuid() });

/**
 * One document per job. User-fixable problems (bad file) fail immediately with a message;
 * transient ones (provider outage) are retried by BullMQ and fail only after the last attempt.
 */
export function ingestionProcessor(deps: IngestDeps, logger: Logger) {
  return async (job: Pick<Job<IngestionJob>, "data" | "id" | "attemptsMade" | "opts">): Promise<string> => {
    const data = Payload.parse(job.data);
    try {
      const result = await ingestDocument(deps, data);
      logger.info({ documentId: data.documentId, result }, "document processed");
      return result;
    } catch (err) {
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      logger.warn(
        { err, documentId: data.documentId, attempt: job.attemptsMade + 1, lastAttempt },
        "document processing failed",
      );
      if (lastAttempt)
        await markFailed(
          deps.prisma,
          data.tenantId,
          data.documentId,
          "Processing failed after several attempts. Please try again later.",
        );
      throw err;
    }
  };
}
