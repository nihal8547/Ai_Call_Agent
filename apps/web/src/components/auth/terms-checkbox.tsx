import type { InputHTMLAttributes, ReactNode } from "react";
import type { LegalLinks } from "@/lib/legal";

const Doc = ({ href, children }: { href: string | null; children: ReactNode }) =>
  href ? (
    <a href={href} target="_blank" rel="noreferrer" className="font-medium text-brand-600 hover:underline">
      {children}
    </a>
  ) : (
    <>{children}</>
  );

/** "I accept the terms of service and privacy policy", with links when the platform has them */
export function TermsCheckbox({
  links,
  error,
  ...input
}: { links: LegalLinks; error?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
        <input
          type="checkbox"
          className="mt-0.5"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "accept-terms-error" : undefined}
          {...input}
        />
        <span>
          I accept the <Doc href={links.terms}>terms of service</Doc> and the{" "}
          <Doc href={links.privacy}>privacy policy</Doc>.
        </span>
      </label>
      {error ? (
        <p id="accept-terms-error" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
