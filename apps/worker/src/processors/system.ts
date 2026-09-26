import { type Job } from "bullmq";
import { z } from "zod";

/** Jobs on the `system` queue. Payloads are validated before any work happens. */
export const SystemJob = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noop"), note: z.string().max(200).optional() }),
]);
export type SystemJob = z.infer<typeof SystemJob>;

export async function processSystemJob(job: Pick<Job, "data" | "id">): Promise<{ ok: true; type: string }> {
  const data = SystemJob.parse(job.data);
  switch (data.type) {
    case "noop":
      return { ok: true, type: data.type };
  }
}
