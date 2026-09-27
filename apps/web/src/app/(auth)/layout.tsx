import { AudioLines } from "lucide-react";
import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-white px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-slate-950 text-white">
            <AudioLines className="size-[18px]" aria-hidden />
          </span>
          <span className="text-lg font-semibold tracking-tight text-slate-950">Voice Agent Platform</span>
        </div>
        {children}
      </div>
    </main>
  );
}
