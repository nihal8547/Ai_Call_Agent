import type { Metadata } from "next";
import { BusinessSettingsPage } from "@/components/settings/business-page";

export const metadata: Metadata = { title: "Business" };

export default function Page() {
  return <BusinessSettingsPage />;
}
