"use client";

import { AgentConfig, type FieldError, zodIssuesToFieldErrors } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import type { AgentDetail } from "@/lib/types";

type Ctx = {
  agent: AgentDetail;
  config: AgentConfig;
  dirty: boolean;
  /** Problems found by the shared schema in the browser, as the user types */
  localErrors: FieldError[];
  serverErrors: FieldError[];
  update: (fn: (c: AgentConfig) => void) => void;
  errorFor: (path: string) => string | undefined;
  save: () => Promise<boolean>;
  saving: boolean;
  reload: () => Promise<void>;
};

const DraftContext = createContext<Ctx | null>(null);

/**
 * Holds the editable copy of an agent's configuration. Edits are validated live with the
 * same zod schema the API uses; saving writes the draft, which calls never use until published.
 */
export function DraftProvider({
  id,
  children,
}: {
  id: string;
  children: (ctx: Ctx | null, error: unknown) => ReactNode;
}) {
  const qc = useQueryClient();
  const agent = useQuery({ queryKey: ["agent", id], queryFn: () => api<AgentDetail>(`/agents/${id}`) });
  const source = agent.data?.draft ?? agent.data?.published;
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldError[]>([]);

  useEffect(() => {
    if (source && !dirty) setConfig(structuredClone(source.config) as unknown as AgentConfig);
  }, [source, dirty]);

  // Warn before leaving the page with unsaved edits
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = useCallback((fn: (c: AgentConfig) => void) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
    setDirty(true);
  }, []);

  const localErrors = useMemo(() => {
    if (!config) return [];
    const r = AgentConfig.safeParse(config);
    return r.success
      ? []
      : zodIssuesToFieldErrors(r.error.issues).map((e) => ({ ...e, path: `config.${e.path}` }));
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: () => api(`/agents/${id}/draft`, { method: "PUT", body: { config } }),
  });

  const value = useMemo<Ctx | null>(() => {
    if (!agent.data || !config) return null;
    const all = [...localErrors, ...serverErrors];
    return {
      agent: agent.data,
      config,
      dirty,
      localErrors,
      serverErrors,
      update,
      errorFor: (path) => all.find((e) => e.path === `config.${path}`)?.message,
      saving: saveMutation.isPending,
      save: async () => {
        try {
          await saveMutation.mutateAsync();
          setServerErrors([]);
          setDirty(false);
          await qc.invalidateQueries({ queryKey: ["agent", id] });
          await qc.invalidateQueries({ queryKey: ["agent-versions", id] });
          return true;
        } catch (e) {
          setServerErrors(e instanceof ApiError ? e.fieldErrors : []);
          return false;
        }
      },
      reload: async () => {
        setDirty(false);
        await qc.invalidateQueries({ queryKey: ["agent", id] });
      },
    };
  }, [agent.data, config, dirty, localErrors, serverErrors, update, saveMutation, qc, id]);

  return <DraftContext.Provider value={value}>{children(value, agent.error)}</DraftContext.Provider>;
}

export function useDraft(): Ctx {
  const ctx = useContext(DraftContext);
  if (!ctx) throw new Error("useDraft outside DraftProvider");
  return ctx;
}

export const slugKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "f_$1")
    .slice(0, 40) || "field";
