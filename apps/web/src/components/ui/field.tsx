import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useId,
} from "react";
import { cn } from "@/lib/cn";

const control =
  "block h-10 w-full rounded-lg border bg-white px-3 text-sm text-slate-900 shadow-xs placeholder:text-slate-400 focus:outline-2 focus:outline-offset-0 focus:outline-brand-500 dark:bg-slate-900 dark:text-slate-100";

type FieldProps = { label: string; error?: string; hint?: ReactNode };

export const TextField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & FieldProps>(
  function TextField({ label, error, hint, className, id, ...props }, ref) {
    const autoId = useId();
    const inputId = id ?? autoId;
    return (
      <div className={className}>
        <label
          htmlFor={inputId}
          className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300"
        >
          {label}
        </label>
        <input
          ref={ref}
          id={inputId}
          dir="auto"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          className={cn(control, error ? "border-red-500" : "border-slate-300 dark:border-slate-700")}
          {...props}
        />
        {error ? (
          <p id={`${inputId}-error`} className="mt-1 text-sm text-red-600">
            {error}
          </p>
        ) : hint ? (
          <p id={`${inputId}-hint`} className="mt-1 text-xs text-slate-500">
            {hint}
          </p>
        ) : null}
      </div>
    );
  },
);

export const SelectField = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & FieldProps
>(function SelectField({ label, error, hint, className, id, children, ...props }, ref) {
  const autoId = useId();
  const selectId = id ?? autoId;
  return (
    <div className={className}>
      <label
        htmlFor={selectId}
        className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300"
      >
        {label}
      </label>
      <select
        ref={ref}
        id={selectId}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint && !error ? `${selectId}-hint` : undefined}
        className={cn(control, error ? "border-red-500" : "border-slate-300 dark:border-slate-700")}
        {...props}
      >
        {children}
      </select>
      {error ? (
        <p className="mt-1 text-sm text-red-600">{error}</p>
      ) : hint ? (
        <p id={`${selectId}-hint`} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
