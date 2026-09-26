import type { Metadata } from "next";
import { PhoneNumbersPage } from "@/components/settings/phone-numbers-page";

export const metadata: Metadata = { title: "Phone numbers" };

export default function Page() {
  return <PhoneNumbersPage />;
}
