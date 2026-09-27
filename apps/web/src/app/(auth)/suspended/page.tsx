import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Account suspended" };

/** Shown when the platform has suspended the business the member is signed in to */
export default function Page() {
  return (
    <div className="rounded-2xl border border-slate-200 p-8 text-center">
      <h1 className="text-xl font-semibold text-slate-950">This business account is suspended</h1>
      <p className="mt-3 text-sm text-slate-600">
        Its calls, WhatsApp replies and sign-ins are paused. Nothing has been deleted. Contact the
        platform&apos;s support to reactivate it.
      </p>
      <p className="mt-6 text-sm">
        <Link href="/login" className="font-medium text-slate-950 underline-offset-4 hover:underline">
          Sign in to another business
        </Link>
      </p>
    </div>
  );
}
