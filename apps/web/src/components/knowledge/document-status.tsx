import { StatusPill } from "@/components/ui/status-pill";
import type { DocumentStatus as Status } from "@/lib/types";

const PHASE: Record<Status, string> = {
  UPLOADING: "Uploading",
  PROCESSING: "Queued",
  EXTRACTING: "Extracting text",
  EMBEDDING: "Embedding",
  READY: "Ready",
  FAILED: "Failed",
};

export const isProcessing = (s: Status) => s !== "READY" && s !== "FAILED";

/** Status pill with the pipeline phase and progress while it runs, and the reason when it failed */
export function DocumentStatus({
  status,
  progress,
  message,
  compact = false,
}: {
  status: Status;
  progress: number;
  message?: string | null;
  /** In lists: only failure reasons, not informational notes */
  compact?: boolean;
}) {
  const note = compact && status !== "FAILED" ? null : message;
  return (
    <div className="flex max-w-56 min-w-28 flex-col gap-1">
      <span className="flex items-center gap-2">
        <StatusPill value={status} />
        {isProcessing(status) ? (
          <span className="text-xs text-slate-500 tabular-nums">{progress}%</span>
        ) : null}
      </span>
      {isProcessing(status) ? (
        <span
          role="progressbar"
          aria-label={PHASE[status]}
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          className="block h-1 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
        >
          <span
            className="block h-full rounded-full bg-brand-500"
            style={{ width: `${Math.max(progress, 3)}%` }}
          />
        </span>
      ) : note ? (
        <span
          className={
            status === "FAILED" ? "text-xs text-red-600 dark:text-red-400" : "text-xs text-slate-500"
          }
        >
          {note}
        </span>
      ) : null}
    </div>
  );
}
