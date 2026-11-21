import type { Metadata } from "next";
import { permanentRedirect } from "next/navigation";
import Forks from "@/components/Forks";
import { forksIndexMetadata } from "@/lib/forksShare";
import { legacyParentPath } from "@/lib/forksLegacy";

export const dynamic = "force-dynamic";

export function generateMetadata(): Promise<Metadata> {
  return forksIndexMetadata();
}

/**
 * /forks. An older episode link (/forks?parent=<hash>[&range=…], also reached from /unknown-parents and /other-chains)
 * redirects (308) to the episode's short link when the summaries have it; otherwise the page opens it as before and
 * rewrites the address itself once it finds it.
 */
export default async function ForksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const target = await legacyParentPath(await searchParams);
  if (target) permanentRedirect(target);
  return (
    <main className="min-h-[calc(100vh-4rem)] w-full">
      <Forks />
    </main>
  );
}
