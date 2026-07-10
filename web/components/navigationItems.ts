import { Activity, ScatterChart, Table, Workflow } from "lucide-react";

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
];
