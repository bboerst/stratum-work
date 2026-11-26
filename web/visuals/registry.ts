import type { VisualDefinition } from "./framework/types";
import poolClocks from "./pool-clocks";
import offMempool from "./off-mempool";

// Every visual, in navigation order. Adding a visual = its folder + one line here (`npm run new-visual` does both).
// Typed loosely here on purpose: each definition is checked against its own settings schema where it's defined.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const visuals: VisualDefinition<any>[] = [offMempool, poolClocks];

export function findVisual(id: string) {
  return visuals.find((v) => v.id === id);
}

/** Visuals listed in the navigation: lab visuals only in development. */
export function listedVisuals(isDev: boolean = process.env.NODE_ENV === "development") {
  return visuals.filter((v) => v.status !== "lab" || isDev);
}
