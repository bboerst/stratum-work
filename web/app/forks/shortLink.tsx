import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Forks from "@/components/Forks";
import { episodeMetadata, resolveCached, siteOrigin } from "@/lib/forksShare";

/**
 * /forks/<height> and /forks/<height>/<kind> (lib/forksPath.ts): the Forks page with that episode selected, in the
 * smallest range that has it. A path that isn't a short link, or a height with no episode, is a 404; with nothing to
 * read (historical data off, a failed read) the page renders without a selection.
 */
export async function shortLinkMetadata(segments: string[]): Promise<Metadata> {
  return episodeMetadata(await resolveCached(segments.join("/")), await siteOrigin());
}

export async function ShortLinkPage({ segments }: { segments: string[] }) {
  const r = await resolveCached(segments.join("/"));
  if (r.status === "invalid" || r.status === "none") notFound();
  return (
    <main className="min-h-[calc(100vh-4rem)] w-full">
      <Forks initial={r.status === "found" ? { range: r.range, parent: r.episode.parent } : null} />
    </main>
  );
}
