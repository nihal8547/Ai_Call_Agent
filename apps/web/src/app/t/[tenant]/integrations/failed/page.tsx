import type { Metadata } from "next";
import { FailedJobsPage } from "@/components/integrations/failed-jobs-page";

export const metadata: Metadata = { title: "Failed deliveries" };

export default function Page() {
  return <FailedJobsPage />;
}
