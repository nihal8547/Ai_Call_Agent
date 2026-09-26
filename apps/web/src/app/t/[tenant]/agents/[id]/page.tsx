import type { Metadata } from "next";
import { AgentEditor } from "@/components/agents/agent-editor";

export const metadata: Metadata = { title: "Edit agent" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AgentEditor id={id} />;
}
