"use client";

import type { MeResponse } from "@platform/shared";
import { createContext, type ReactNode, useContext } from "react";

const MeContext = createContext<MeResponse | null>(null);

export function MeProvider({ me, children }: { me: MeResponse; children: ReactNode }) {
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

export function useMe(): MeResponse {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe must be used inside the app layout");
  return me;
}

/** UI-level check only; the API enforces every permission independently */
export function useCan(...permissions: string[]): boolean {
  const me = useMe();
  return permissions.every((p) => me.permissions.includes(p));
}
