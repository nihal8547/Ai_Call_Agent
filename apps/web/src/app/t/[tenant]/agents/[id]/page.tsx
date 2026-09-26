import type { Metadata } from "next";
import { Suspense } from "react";
import { AgentEditor } from "@/components/agents/editor/agent-editor";

export const metadata: Metadata = { title: "Edit agent" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <AgentEditor id={id} />
    </Suspense>
  );
}
