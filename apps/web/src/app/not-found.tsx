import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-4">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <Link href="/" className="text-brand-600 underline">
        Go home
      </Link>
    </main>
  );
}
