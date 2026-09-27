import type { Metadata } from "next";
import { SecurityPage } from "@/components/settings/security-page";

export const metadata: Metadata = { title: "Security" };

export default function Page() {
  return <SecurityPage />;
}
