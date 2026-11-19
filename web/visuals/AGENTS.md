# Visuals: how to add one

Guide for agents and humans adding a visualization to stratum.work (#157). A visual is **one folder** in
`web/visuals/<id>/`. The app provides everything around it: the route (`/v/<id>`), the navigation entry, the frame
(title, description, settings, full screen, "about"), the settings panel and the data. You write the data shaping and
the drawing.

## Quick start
```bash
cd web
npm run new-visual fee-bands "Fee bands"   # scaffolds web/visuals/fee-bands/ and registers it (status "lab")
npm test                                    # the scaffold's test passes out of the box
npm run dev                                 # open http://localhost:3000/v/fee-bands
```
Then edit `selectors.ts` (data) and `<Name>.tsx` (drawing), and set `status` when it's ready.

## Design principle
Simple, in the spirit of mempool.space: a visual should be clear enough from its data that it needs no explanation.
- **Minimal text.** A title and at most one short line. No explanatory paragraphs: link the reasoning in
  [`docs/methodology.md`](../../docs/methodology.md) instead (a small info icon).
- **Colour and shape carry the meaning**, with a tiny legend of coloured dots. Few numbers; large, clear marks.
- **Details on hover or click**, never inline: compact tooltips, a selected item's one-line header, lists collapsed
  behind a toggle.
- Calm, dark-first styling with the app's theme tokens and generous spacing.

## The contract
`index.ts` exports `defineVisual({...})` (`framework/types.ts`):

| Field | What |
|---|---|
| `id` | URL-safe, unique. The route is `/v/<id>`. |
| `title`, `description` | Shown in the frame and the navigation. One sentence for the description. |
| `icon` | A `lucide-react` icon. |
| `status` | `lab` (development only), `beta` (listed with a badge), `stable`. |
| `settings` | A schema (`settings.ts`), see below. |
| `component` | Receives `{ settings, instanceKey, standalone }`. |
| `about` | Optional paragraphs: how to read it, caveats. Shown collapsed under the visual. |

Register it with one line in `registry.ts` (the scaffold does this). Nothing else in the app changes.

## Settings
Declare them; never build settings UI. Types: `boolean`, `number` (`min`, `max`, `step`, `unit`), `enum`
(`options`). Give each a `label`, a `default`, and `help` when it isn't obvious.

```ts
export const feeBandsSettings = {
  heights: { type: "number", label: "Heights", default: 3, min: 1, max: 3 },
  scale: { type: "enum", label: "Scale", default: "log", options: [{ value: "log", label: "Log" }, { value: "linear", label: "Linear" }] },
} as const satisfies SettingsSchema;
```
The frame renders the panel, validates values, keeps them in the URL (shareable links, non-defaults only) and in
browser storage (the viewer's last choice). `settings` in your component is typed from the schema.

## Data
Use the hooks in `framework/data.ts`; never fetch APIs or open the stream in a visual.
- `useTemplates({ heights })`: recent Bitcoin templates (live stream + history prefill) for the pools the viewer has
  selected, oldest first, plus `currentHeight`, `tipHeight`, `loading`. Flood protection and the
  pool blacklist are already applied.
- Shared decoding lives in `web/utils/`: `coinbaseParser.ts` (scriptSig segments: height, pool time, tags, AuxPoW,
  extranonce placement; outputs by byte range), `bitcoinUtils.ts` (outputs, OP_RETURN protocols). Use them instead
  of re-parsing.
- Need another source (blocks, history by height range, infra metrics)? Add a hook to `framework/data.ts`, so every
  visual gets it.

## Drawing
- **D3 for scales, axes math, shapes; React for the DOM** (render SVG elements in JSX). No `d3.select` into React
  nodes. Canvas is fine past a few thousand marks.
- Size to the container: `useElementWidth()`, not the window. Your visual may share a page with others.
- Colours: `poolColor(pool)` (`framework/poolColors.ts`) so a pool has the same colour everywhere. Use
  `currentColor` / theme classes for text and axes, so light and dark themes both work.
- Empty and loading states: `<VisualMessage>`. Say what's missing ("No pool pushed a timestamp in the last 3
  heights yet"), not just "No data".
- Accessibility: give the `<svg>` `role="img"` and a `<desc>`; use `instanceKey` for element ids.
- Text from templates is untrusted (it comes from pools): render it as text in JSX, never as HTML.

## Performance
- Keep data shaping in `selectors.ts`: pure functions, `useMemo` on the inputs from the hooks. The buffer updates at
  most every 150 ms, but can hold thousands of templates.
- Cache per-template work by object identity (`WeakMap<StratumV1Data, …>`): buffered templates don't change.
- Cap what you draw (e.g. the last N points per pool) and say so in the UI if it matters.

Measure it: `npm run perf` (`web/perf/README.md`) reports load time, main-thread blocking, streaming CPU, FPS and
memory per page; CI posts it on every web PR. Add a primary visual's path to the harness's default pages.

## Tests
`__tests__/<name>.test.ts` next to the visual: unit-test the selectors with **synthetic** templates (never real
coinbases, pool names or endpoints: this repository is public). `npm test`, `npx tsc --noEmit`, `npm run lint`.

## Sharing a page later
Visuals are built to be composable: a visual gets its settings and an `instanceKey` as props and reads data through
shared hooks, and the frame takes a `queryPrefix` so two instances keep separate settings in one URL. Don't rely on
the global page menu or on being the only visual on the page.

## Example
`pool-clocks/`: the pool's pushed coinbase time vs ntime or our receive time, per pool, with a similar-clock hint.
