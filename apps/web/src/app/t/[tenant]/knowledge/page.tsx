import type { Metadata } from "next";
import { Suspense } from "react";
import { KnowledgePage } from "@/components/knowledge/knowledge-page";

export const metadata: Metadata = { title: "Knowledge Base" };

export default function Page() {
  return (
    <Suspense>
      <KnowledgePage />
    </Suspense>
  );
}
