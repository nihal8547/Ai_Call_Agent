import { MessageCircle, Mic, UserRoundCheck } from "lucide-react";
import type { Metadata } from "next";
import { Card, PageHeader } from "@/components/ui/misc";

export const metadata: Metadata = { title: "Inbox" };

const COMING = [
  {
    icon: MessageCircle,
    title: "Automatic replies on WhatsApp",
    text: "Your agent answers customers from your knowledge base, asks your questions and books appointments.",
  },
  {
    icon: Mic,
    title: "Voice notes",
    text: "Voice messages are transcribed and answered with a voice note in the customer's language.",
  },
  {
    icon: UserRoundCheck,
    title: "Take over any conversation",
    text: "See every chat with its full history, reply yourself, then hand it back to the agent.",
  },
];

export default function InboxPage() {
  return (
    <div>
      <PageHeader title="Inbox" description="WhatsApp conversations answered by your agents." />
      <Card className="p-8">
        <p className="text-sm font-medium text-slate-500">Coming soon</p>
        <h2 className="mt-1 text-lg font-semibold text-slate-950">Connect WhatsApp to start</h2>
        <p className="mt-1 max-w-xl text-[15px] text-slate-500">
          Connecting your WhatsApp Business number with the official WhatsApp API is being built. Once
          it&apos;s ready, you&apos;ll connect it in a few clicks and conversations will appear here.
        </p>
        <ul className="mt-8 grid gap-6 sm:grid-cols-3">
          {COMING.map(({ icon: Icon, title, text }) => (
            <li key={title}>
              <Icon className="size-5 text-slate-900" aria-hidden />
              <p className="mt-3 text-sm font-semibold text-slate-950">{title}</p>
              <p className="mt-1 text-sm text-slate-500">{text}</p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
