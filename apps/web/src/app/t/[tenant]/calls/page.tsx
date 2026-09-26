import type { Metadata } from "next";
import { Suspense } from "react";
import { CallsPage } from "@/components/calls/calls-page";

export const metadata: Metadata = { title: "Calls" };

export default function Page() {
  return (
    <Suspense>
      <CallsPage />
    </Suspense>
  );
}
