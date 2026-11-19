import type { Metadata } from "next";
import Forks from "@/components/Forks";

export const metadata: Metadata = { title: "Forks" };

export default function ForksPage() {
  return (
    <main className="min-h-[calc(100vh-4rem)] w-full">
      <Forks />
    </main>
  );
}
