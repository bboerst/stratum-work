#!/usr/bin/env node
// npm run new-visual <id> ["Title"]: scaffolds web/visuals/<id>/ (definition, settings, component, selectors, test)
// and registers it in web/visuals/registry.ts with status "lab" (shown in development only). See web/visuals/AGENTS.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "visuals");
const [id, titleArg] = process.argv.slice(2);
if (!id || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
  console.error("usage: npm run new-visual <id> [\"Title\"]   (id: lower-case words joined by '-', e.g. fee-bands)");
  process.exit(1);
}
const dir = join(root, id);
if (existsSync(dir)) {
  console.error(`web/visuals/${id} already exists`);
  process.exit(1);
}
const camel = id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const Pascal = camel[0].toUpperCase() + camel.slice(1);
const title = titleArg || id.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

const files = {
  "settings.ts": `import type { SettingsSchema } from "../framework/types";

export const ${camel}Settings = {
  heights: { type: "number", label: "Heights", default: 3, min: 1, max: 3, help: "How many recent heights to include." },
} as const satisfies SettingsSchema;
`,
  "selectors.ts": `import type { BufferedTemplate } from "@/lib/templateBuffer";

// Pure data shaping for ${title}: unit-tested in __tests__/, no React or DOM here.

export interface ${Pascal}Row {
  pool: string;
  templates: number;
}

export function ${camel}Rows(templates: BufferedTemplate[]): ${Pascal}Row[] {
  const counts = new Map<string, number>();
  for (const t of templates) counts.set(t.data.pool_name, (counts.get(t.data.pool_name) ?? 0) + 1);
  return [...counts].map(([pool, n]) => ({ pool, templates: n })).sort((a, b) => b.templates - a.templates || a.pool.localeCompare(b.pool));
}
`,
  [`${Pascal}.tsx`]: `"use client";

import React, { useMemo } from "react";
import * as d3 from "d3";
import type { VisualProps } from "../framework/types";
import { useTemplates } from "../framework/data";
import { poolColor } from "../framework/poolColors";
import { useElementWidth } from "../framework/useElementWidth";
import { VisualMessage } from "../framework/VisualFrame";
import { ${camel}Rows } from "./selectors";
import type { ${camel}Settings } from "./settings";

const ROW = 22;
const MARGIN = { top: 8, right: 48, bottom: 24, left: 140 };

export default function ${Pascal}({ settings, instanceKey }: VisualProps<typeof ${camel}Settings>) {
  const { templates, loading } = useTemplates({ heights: settings.heights });
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const rows = useMemo(() => ${camel}Rows(templates), [templates]);

  if (loading && templates.length === 0) return <VisualMessage>Loading templates…</VisualMessage>;
  if (rows.length === 0) return <VisualMessage>No templates yet.</VisualMessage>;

  const innerW = Math.max(200, width - MARGIN.left - MARGIN.right);
  const x = d3.scaleLinear().domain([0, d3.max(rows, (r) => r.templates) ?? 1]).range([0, innerW]).nice();
  const height = MARGIN.top + MARGIN.bottom + rows.length * ROW;

  return (
    <div ref={ref} className="w-full">
      <svg width={width} height={height} role="img" aria-labelledby={\`\${instanceKey}-desc\`} className="text-foreground">
        <desc id={\`\${instanceKey}-desc\`}>Templates per pool.</desc>
        <g transform={\`translate(\${MARGIN.left},\${MARGIN.top})\`}>
          {rows.map((r, i) => (
            <g key={r.pool} transform={\`translate(0,\${i * ROW})\`}>
              <text x={-8} y={ROW / 2} dy="0.35em" textAnchor="end" fontSize={12} fill="currentColor">{r.pool}</text>
              <rect width={x(r.templates)} height={ROW - 6} y={3} fill={poolColor(r.pool)} rx={2} />
              <text x={x(r.templates) + 6} y={ROW / 2} dy="0.35em" fontSize={11} fill="currentColor">{r.templates}</text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
`,
  "index.ts": `import { Sparkles } from "lucide-react";
import { defineVisual } from "../framework/types";
import ${Pascal} from "./${Pascal}";
import { ${camel}Settings } from "./settings";

export default defineVisual({
  id: "${id}",
  title: "${title.replace(/"/g, '\\"')}",
  description: "TODO: one sentence on what this shows.",
  icon: Sparkles,
  status: "lab",
  settings: ${camel}Settings,
  component: ${Pascal},
  about: ["TODO: how to read it, and its caveats."],
});
`,
  [`__tests__/${camel}.test.ts`]: `import { describe, it, expect } from "vitest";
import { ${camel}Rows } from "../selectors";
import type { BufferedTemplate } from "@/lib/templateBuffer";

const t = (pool: string, i: number) => ({ key: \`\${pool}-\${i}\`, seq: i, origin: "live", timeMs: i, data: { pool_name: pool } }) as unknown as BufferedTemplate;

describe("${id}", () => {
  it("counts templates per pool", () => {
    expect(${camel}Rows([t("A", 1), t("B", 2), t("A", 3)])).toEqual([{ pool: "A", templates: 2 }, { pool: "B", templates: 1 }]);
  });
});
`,
};

mkdirSync(join(dir, "__tests__"), { recursive: true });
for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);

const registry = join(root, "registry.ts");
let reg = readFileSync(registry, "utf8");
const lastImport = [...reg.matchAll(/^import .* from "\.\/[^"]+";$/gm)].pop();
reg = reg.slice(0, lastImport.index + lastImport[0].length) + `\nimport ${camel} from "./${id}";` + reg.slice(lastImport.index + lastImport[0].length);
reg = reg.replace(/export const visuals: VisualDefinition<any>\[\] = \[([^\]]*)\];/, (_, list) => `export const visuals: VisualDefinition<any>[] = [${list.trim() ? list.trim() + ", " : ""}${camel}];`);
writeFileSync(registry, reg);

console.log(`Created web/visuals/${id}/ and registered it (status "lab": listed in development only).
Next: read web/visuals/AGENTS.md, edit selectors.ts + ${Pascal}.tsx, run npm test, open /v/${id}.`);
