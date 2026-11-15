import { Activity, ScatterChart, Table, Workflow } from "lucide-react";
import { listedVisuals } from "@/visuals/registry";

export const navItems = [
  {
    href: "/",
    label: "Table",
    icon: Table,
    description: "Main view with table and timing chart",
  },
  {
    href: "/timing",
    label: "Timing",
    icon: ScatterChart,
    description: "Full screen pool timing visualization",
  },
  {
    href: "/sankey",
    label: "Sankey",
    icon: Workflow,
    description: "Sankey diagram visualization",
  },
  {
    href: "/infra",
    label: "Infra",
    icon: Activity,
    description: "Realtime Stratum infrastructure metrics",
  },
  // Visuals from the registry (web/visuals/, #157): each is served at /v/<id>.
  ...listedVisuals().map((v) => ({
    href: `/v/${v.id}`,
    label: v.title,
    icon: v.icon,
    description: v.description,
  })),
];
