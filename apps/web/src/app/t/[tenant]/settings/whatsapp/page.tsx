import type { Metadata } from "next";
import { WhatsAppSettingsPage } from "@/components/whatsapp/whatsapp-settings";

export const metadata: Metadata = { title: "WhatsApp" };

export default function Page() {
  return <WhatsAppSettingsPage />;
}
