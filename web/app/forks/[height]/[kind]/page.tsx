import type { Metadata } from "next";
import { ShortLinkPage, shortLinkMetadata } from "../../shortLink";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ height: string; kind: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { height, kind } = await params;
  return shortLinkMetadata([height, kind]);
}

export default async function ForksKindPage({ params }: Props) {
  const { height, kind } = await params;
  return <ShortLinkPage segments={[height, kind]} />;
}
