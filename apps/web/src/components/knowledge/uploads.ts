"use client";

import { useState } from "react";
import { upload } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";

export const ACCEPT = ".pdf,.docx,.xlsx,.csv,.txt,.md,.png,.jpg,.jpeg,.webp";

type Upload = { key: string; name: string; progress: number; error?: string };

/** Upload several files in parallel (max 3 at a time), tracking progress per file */
export function useUploads(collectionId: string, onUploaded: () => Promise<void>) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const patch = (key: string, p: Partial<Upload>) =>
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...p } : u)));

  const start = (files: File[]) => {
    const queue = files.map((file) => ({ file, key: `${file.name}-${Math.random().toString(36).slice(2)}` }));
    // Build the rows now: the updater may run after the workers below have drained `queue`
    const rows = queue.map(({ file, key }) => ({ key, name: file.name, progress: 0 }));
    setUploads((list) => [...list, ...rows]);
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const { file, key } = next;
        const form = new FormData();
        form.append("collectionId", collectionId);
        form.append("file", file);
        try {
          await upload("/documents", form, (p) => patch(key, { progress: p }));
          setUploads((list) => list.filter((u) => u.key !== key));
          await onUploaded();
        } catch (err) {
          patch(key, { error: errorMessage(err) });
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
  };

  const dismiss = (key: string) => setUploads((list) => list.filter((u) => u.key !== key));
  return { uploads, start, dismiss };
}
