import { cache } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { loadEpisodes } from "./forksSummary";
import type { Episode } from "./unknownParents";
import {
  FORKS_DESCRIPTION, FORKS_TITLE, SITE_NAME, episodeDescription, episodeTitle, parseForksPath, resolvePath, shortPath,
  type ShareRange,
} from "./forksPath";

/**
 * The Forks pages' server side: a short link resolved to its episode (once per request: generateMetadata, the page and
 * the preview image share it), and the link-preview metadata.
 */

export type Resolved =
  | { status: "found"; range: ShareRange; episode: Episode; canonical: string; exact: boolean }
  | { status: "none" }        // the data was read and has no episode at that height: 404
  | { status: "no-data" }     // nothing to read (historical data off, or the read failed): the page without a selection
  | { status: "invalid" };    // not a short link: 404

export async function resolveSegments(segments: string[], load = loadEpisodes): Promise<Resolved> {
  const path = parseForksPath(segments);
  if (!path) return { status: "invalid" };
  let read = false;
  const r = await resolvePath(path, async range => {
    const eps = await load(range);
    if (eps) read = true;
    return eps;
  });
  if (!r) return { status: read ? "none" : "no-data" };
  return { status: "found", range: r.range, episode: r.episode, canonical: shortPath(r.episode, r.episodes), exact: r.exact };
}

/** Per request (React cache): the page, its metadata and its image resolve a link once. */
export const resolveCached = cache((key: string) => resolveSegments(key.split("/")));

/**
 * The site's origin for absolute link-preview URLs, from the request (the same image serves every deployment):
 * SITE_URL when set, else the forwarded host and protocol, else the Host header.
 */
export async function siteOrigin(): Promise<URL | undefined> {
  if (process.env.SITE_URL) {
    try { return new URL(process.env.SITE_URL); } catch { /* fall through to the request */ }
  }
  const h = await headers();
  const first = (v: string | null) => v?.split(",")[0]?.trim() || null;
  const host = first(h.get("x-forwarded-host")) ?? first(h.get("host"));
  if (!host) return undefined;
  const proto = first(h.get("x-forwarded-proto")) ?? "http";
  try { return new URL(`${proto}://${host}`); } catch { return undefined; }
}

/** Title, description, canonical URL and the OpenGraph / Twitter fields (the images come from opengraph-image.tsx). */
export function shareMetadata(o: {
  title: string; description: string; path: string; origin: URL | undefined; card?: "summary" | "summary_large_image";
}): Metadata {
  return {
    metadataBase: o.origin,
    title: { absolute: o.title },
    description: o.description,
    alternates: { canonical: o.path },
    openGraph: { title: o.title, description: o.description, url: o.path, siteName: SITE_NAME, type: "website" },
    twitter: { card: o.card ?? "summary_large_image", title: o.title, description: o.description },
  };
}

export async function forksIndexMetadata(): Promise<Metadata> {
  return shareMetadata({ title: FORKS_TITLE, description: FORKS_DESCRIPTION, path: "/forks", origin: await siteOrigin() });
}

/** A short link's metadata: the episode's title and facts, or the page's own when there is no episode to name. */
export function episodeMetadata(r: Resolved, origin: URL | undefined): Metadata {
  if (r.status !== "found") return shareMetadata({ title: FORKS_TITLE, description: FORKS_DESCRIPTION, path: "/forks", origin });
  return shareMetadata({ title: episodeTitle(r.episode), description: episodeDescription(r.episode), path: r.canonical, origin });
}
