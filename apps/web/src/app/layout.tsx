import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: { default: "Voice Agent Platform", template: "%s · Voice Agent Platform" },
  description: "Build, run and monitor AI voice agents for your business",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading the request makes every page render per request, so Next adds the CSP nonce to its scripts
  await headers();
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
