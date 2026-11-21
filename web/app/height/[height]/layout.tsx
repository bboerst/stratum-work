import type { Metadata } from "next";
import { shareMetadata, siteOrigin } from "@/lib/forksShare";
import { SITE_NAME, fmtInt } from "@/lib/forksPath";

/** The height page is a client component: its title and link preview come from here (no database read). */
export async function generateMetadata({ params }: { params: Promise<{ height: string }> }): Promise<Metadata> {
  const { height } = await params;
  const h = /^[1-9][0-9]{0,8}$/.test(height) ? Number(height) : null;
  if (h === null) return { title: { absolute: SITE_NAME } };
  return shareMetadata({
    title: `Block ${fmtInt(h)} · ${SITE_NAME}`,
    description: `The templates mining pools sent for block ${fmtInt(h)}: when each pool's first template arrived, the timing plots and the findings.`,
    path: `/height/${h}`,
    origin: await siteOrigin(),
    card: "summary",   // no image of its own
  });
}

export default function HeightLayout({ children }: { children: React.ReactNode }) {
  return children;
}
