import { redirect } from "next/navigation";
import { getMe } from "@/lib/api/server";

export const dynamic = "force-dynamic";

export default async function Home() {
  const me = await getMe().catch(() => null);
  redirect(me ? `/t/${me.tenant.slug}/dashboard` : "/login");
}
