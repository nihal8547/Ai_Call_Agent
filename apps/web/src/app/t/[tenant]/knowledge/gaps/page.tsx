import type { Metadata } from "next";
import { KnowledgeGapsPage } from "@/components/knowledge/gaps-page";

export const metadata: Metadata = { title: "Knowledge gaps" };

export default function Page() {
  return <KnowledgeGapsPage />;
}
