import type { Metadata } from "next";
import { PlatformBusiness } from "@/components/platform/platform-business";

export const metadata: Metadata = { title: "Business" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlatformBusiness id={id} />;
}
