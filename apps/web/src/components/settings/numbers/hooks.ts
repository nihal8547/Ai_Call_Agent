"use client";

import { useQuery } from "@tanstack/react-query";
import { useCan } from "@/components/app/me-context";
import { api } from "@/lib/api/client";
import type { AgentListItem, PhoneNumber } from "@/lib/types";

export type NumbersData = { items: PhoneNumber[]; twilioAccount: boolean };

/** Shared by every part of the page; polls while a test call is awaited */
export function useNumbers() {
  return useQuery({
    queryKey: ["phone-numbers"],
    queryFn: () => api<NumbersData>("/phone-numbers"),
    refetchInterval: (q) =>
      q.state.data?.items.some((n) => n.verificationStatus === "PENDING") ? 3000 : false,
  });
}

export function useAgents() {
  const canRead = useCan("agents:read");
  return useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ items: AgentListItem[] }>("/agents"),
    enabled: canRead,
  });
}
