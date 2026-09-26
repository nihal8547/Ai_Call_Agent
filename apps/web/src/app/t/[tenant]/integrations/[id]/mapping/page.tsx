import type { Metadata } from "next";
import { CrmMappingPage } from "@/components/integrations/crm-mapping-page";

export const metadata: Metadata = { title: "CRM field mapping" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CrmMappingPage key={id} id={id} />;
}
