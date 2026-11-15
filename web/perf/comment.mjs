// Posts (or updates) the perf report as one sticky PR comment. Used by .github/workflows/perf.yml.
// env: GH_TOKEN, REPO (owner/name), PR (number). arg: the markdown file.
import { readFileSync } from "node:fs";

const MARKER = "<!-- stratum-work perf report -->";
const { GH_TOKEN, REPO, PR } = process.env;
const body = `${MARKER}\n${readFileSync(process.argv[2], "utf8")}`;
const api = (path, init = {}) =>
  fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
  }).then(async (r) => {
    if (!r.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${r.status} ${await r.text()}`);
    return r.json();
  });

const comments = await api(`/issues/${PR}/comments?per_page=100`);
const mine = comments.find((c) => c.body?.startsWith(MARKER));
if (mine) await api(`/issues/comments/${mine.id}`, { method: "PATCH", body: JSON.stringify({ body }) });
else await api(`/issues/${PR}/comments`, { method: "POST", body: JSON.stringify({ body }) });
console.log(mine ? "updated the perf comment" : "posted the perf comment");
