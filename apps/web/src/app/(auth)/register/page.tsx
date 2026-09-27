import type { Metadata } from "next";
import { RegisterForm } from "@/components/auth/register-form";
import { legalLinks } from "@/lib/legal";

export const metadata: Metadata = { title: "Create account" };

export default async function RegisterPage() {
  return <RegisterForm legal={await legalLinks()} />;
}
