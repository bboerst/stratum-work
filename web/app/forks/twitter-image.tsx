// The link-preview card (app/forks/ogImage.tsx); reads the database at request time, never at build.
import { forksImage } from "./ogImage";

export const dynamic = "force-dynamic";
export const alt = "Forks on stratum.work";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return forksImage();
}
