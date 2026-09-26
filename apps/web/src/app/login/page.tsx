import type { Metadata } from "next";

export const metadata: Metadata = { title: "Sign in" };

// Placeholder: the working form arrives with authentication in phase P2.
export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h1 className="text-xl font-semibold">Voice Agent Platform</h1>
        <p className="mt-2 text-sm text-slate-500">Sign-in is coming in the next phase.</p>
      </div>
    </main>
  );
}
