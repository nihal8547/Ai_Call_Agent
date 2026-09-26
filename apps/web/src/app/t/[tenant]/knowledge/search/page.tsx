import type { Metadata } from "next";
import { SearchPlayground } from "@/components/knowledge/search-playground";

export const metadata: Metadata = { title: "Search playground" };

export default function Page() {
  return <SearchPlayground />;
}
