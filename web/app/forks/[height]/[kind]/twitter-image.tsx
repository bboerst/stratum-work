// The link-preview card (app/forks/ogImage.tsx); reads the database at request time, never at build.
import { episodeImage } from "../../ogImage";

export const dynamic = "force-dynamic";
export const alt = "A fork episode on stratum.work";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ height: string; kind: string }> }) {
  const { height, kind } = await params;
  return episodeImage([height, kind]);
}
