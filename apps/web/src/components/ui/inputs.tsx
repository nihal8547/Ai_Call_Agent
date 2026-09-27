import { type ReactNode, type TextareaHTMLAttributes, useId } from "react";
import { cn } from "@/lib/cn";

export function TextArea({
  label,
  hint,
  error,
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: ReactNode; error?: string }) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
        {label}
      </label>
      <textarea
        id={id}
        dir="auto"
        aria-invalid={error ? true : undefined}
        className={cn(
          "block w-full rounded-lg border bg-white px-3 py-2 text-sm focus:outline-2 focus:outline-brand-500 dark:bg-slate-900",
          error ? "border-red-500" : "border-slate-300 dark:border-slate-700",
        )}
        {...props}
      />
      {error ? (
        <p className="mt-1 text-sm text-red-600">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

export function Check({
  label,
  checked,
  onChange,
  hint,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint ? <span className="block text-xs text-slate-500">{hint}</span> : null}
      </span>
    </label>
  );
}

export function Section({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {description ? <p className="text-sm text-slate-500">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
