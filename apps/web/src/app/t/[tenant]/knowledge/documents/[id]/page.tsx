import type { Metadata } from "next";
import { DocumentDetail } from "@/components/knowledge/document-detail";

export const metadata: Metadata = { title: "Document" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DocumentDetail key={id} id={id} />;
}
