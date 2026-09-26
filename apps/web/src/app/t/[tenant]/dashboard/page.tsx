import type { Metadata } from "next";
import { Card, PageHeader } from "@/components/ui/misc";

export const metadata: Metadata = { title: "Dashboard" };

const STEPS = [
  [
    "Create an AI agent",
    "Pick a template (real estate, clinic, hotel…) and set its greeting, questions and rules.",
  ],
  ["Add your knowledge", "Upload PDFs, price lists and FAQs so the agent answers from your own information."],
  ["Connect a phone number", "Route calls from your Twilio number to the agent."],
  ["Invite your team", "Give managers and staff access to calls, leads and appointments."],
];

export default function DashboardPage() {
  return (
    <>
      <PageHeader title="Dashboard" description="Call metrics appear here once your first agent goes live." />
      <div className="grid gap-4 sm:grid-cols-2">
        {STEPS.map(([title, body], i) => (
          <Card key={title}>
            <p className="text-xs font-semibold text-brand-600">Step {i + 1}</p>
            <h2 className="mt-1 font-semibold">{title}</h2>
            <p className="mt-1 text-sm text-slate-500">{body}</p>
          </Card>
        ))}
      </div>
    </>
  );
}
