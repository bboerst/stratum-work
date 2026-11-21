import type { Metadata } from "next";
import { ShortLinkPage, shortLinkMetadata } from "../shortLink";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ height: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { height } = await params;
  return shortLinkMetadata([height]);
}

export default async function ForksHeightPage({ params }: Props) {
  const { height } = await params;
  return <ShortLinkPage segments={[height]} />;
}
