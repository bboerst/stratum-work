import { Activity, LayoutDashboard, LayoutGrid, ScatterChart, Table, Workflow } from "lucide-react";

/** Shown as a small header link, not a nav tab. */
export const donateLink = { href: "/donate", label: "Donate hashrate" };

export const navItems = [
  {
    href: "/",
    label: "Overview",
    icon: LayoutDashboard,
    description: "Who decides the next block",
  },
  {
    href: "/table",
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
    href: "/workspace",
    label: "Workspace",
    icon: LayoutGrid,
    description: "Compose and share visuals",
  },
  {
    href: "/infra",
    label: "Infra",
    icon: Activity,
    description: "Realtime Stratum infrastructure metrics",
  },
];
