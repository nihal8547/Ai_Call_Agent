import { cn } from "@/lib/cn";
import { humanize } from "@/lib/format";

const TONES: Record<string, string> = {
  good: "bg-green-50 text-green-800 ring-green-600/20 dark:bg-green-950 dark:text-green-200",
  warn: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-200",
  bad: "bg-red-50 text-red-800 ring-red-600/20 dark:bg-red-950 dark:text-red-200",
  info: "bg-blue-50 text-blue-800 ring-blue-600/20 dark:bg-blue-950 dark:text-blue-200",
  neutral: "bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-300",
};

const TONE_OF: Record<string, keyof typeof TONES> = {
  ACTIVE: "good",
  PUBLISHED: "good",
  COMPLETED: "good",
  APPOINTMENT_BOOKED: "good",
  LEAD_CAPTURED: "good",
  QUALIFIED: "good",
  IN_PROGRESS: "info",
  HUMAN_HANDOFF: "info",
  ENQUIRY_ANSWERED: "info",
  DRAFT: "warn",
  PARTIAL: "warn",
  FOLLOW_UP_REQUIRED: "warn",
  INACTIVE: "neutral",
  FAILED: "bad",
  READY: "good",
  CONNECTED: "good",
  UPCOMING: "info",
  NO_SHOW: "bad",
  CANCELLED: "neutral",
  RESCHEDULED: "neutral",
  ERROR: "bad",
  EXPIRED: "warn",
  DISCONNECTED: "neutral",
  UPLOADING: "info",
  PROCESSING: "info",
  EXTRACTING: "info",
  EMBEDDING: "info",
  NO_ANSWER: "bad",
  BUSY: "bad",
  ABANDONED: "neutral",
};

/** Status label with a text label always present (color is never the only signal) */
export function StatusPill({ value, className }: { value: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        TONES[TONE_OF[value] ?? "neutral"],
        className,
      )}
    >
      {humanize(value)}
    </span>
  );
}
