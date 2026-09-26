import type { Metadata } from "next";
import { CallDetailPage } from "@/components/calls/call-detail";

export const metadata: Metadata = { title: "Call" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CallDetailPage id={id} />;
}
