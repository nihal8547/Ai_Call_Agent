import { z } from "zod";

export const PAGE_LIMIT_DEFAULT = 25;
export const PAGE_LIMIT_MAX = 100;

export const CursorPageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
});
export type CursorPageQuery = z.infer<typeof CursorPageQuery>;

export function cursorPage<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export type CursorPage<T> = { items: T[]; nextCursor: string | null };

export const Uuid = z.uuid();
export const IdParam = z.object({ id: Uuid });
