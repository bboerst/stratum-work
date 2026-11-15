import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { findVisual, visuals } from "@/visuals/registry";
import VisualPage from "./VisualPage";

// One route for every visual in web/visuals/ (#157). Unknown ids are a real 404.

type Params = { params: Promise<{ id: string }> };

export function generateStaticParams() {
  return visuals.map((v) => ({ id: v.id }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const visual = findVisual((await params).id);
  return visual ? { title: `${visual.title} · stratum.work`, description: visual.description } : {};
}

export default async function Page({ params }: Params) {
  const { id } = await params;
  if (!findVisual(id)) notFound();
  return <VisualPage id={id} />;
}
