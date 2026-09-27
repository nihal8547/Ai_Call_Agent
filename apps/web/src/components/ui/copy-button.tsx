"use client";

import { useState } from "react";
import { Button } from "./button";

/** Copies text and says so for a moment (screen readers hear it through the live label) */
export function CopyButton({
  text,
  label = "Copy",
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      className={className ?? "h-8 px-3"}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </Button>
  );
}
