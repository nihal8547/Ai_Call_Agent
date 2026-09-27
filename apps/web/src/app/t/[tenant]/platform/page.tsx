import type { Metadata } from "next";
import { PlatformPage } from "@/components/platform/platform-page";

export const metadata: Metadata = { title: "Businesses" };

export default function Page() {
  return <PlatformPage />;
}
