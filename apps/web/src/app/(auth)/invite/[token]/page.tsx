import type { Metadata } from "next";
import { AcceptInviteForm } from "@/components/auth/accept-invite-form";
import { legalLinks } from "@/lib/legal";

export const metadata: Metadata = { title: "Accept invitation", referrer: "no-referrer" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <AcceptInviteForm token={token} legal={await legalLinks()} />;
}
