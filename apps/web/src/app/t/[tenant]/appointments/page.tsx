import type { Metadata } from "next";
import { Suspense } from "react";
import { AppointmentsPage } from "@/components/appointments/appointments-page";

export const metadata: Metadata = { title: "Appointments" };

export default function Page() {
  return (
    <Suspense>
      <AppointmentsPage />
    </Suspense>
  );
}
