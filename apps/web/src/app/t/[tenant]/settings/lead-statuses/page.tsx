import type { Metadata } from "next";
import { LeadStatusesPage } from "@/components/settings/lead-statuses-page";

export const metadata: Metadata = { title: "Lead statuses" };

export default function Page() {
  return <LeadStatusesPage />;
}
