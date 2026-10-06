{{/*
Multi-pool helpers (used only when .Values.pools is non-empty).
*/}}

{{/*
Pool slug: name lowercased, runs of non-alphanumerics -> "-", trimmed of "-",
truncated to 34 chars so "collector-<slug>-observe" stays <= 52 chars. 52 (not
63) because the StatefulSet controller adds a "controller-revision-hash" pod
label of "<sts-name>-<10 char hash>", which must itself fit in 63 chars.
Usage: include "collector.poolSlug" "<pool name>"
*/}}
{{- define "collector.poolSlug" -}}
{{- $s := regexReplaceAll "[^a-z0-9]+" (lower .) "-" | trimAll "-" | trunc 34 | trimSuffix "-" -}}
{{- if not $s -}}
{{- fail (printf "pools: name %q produces an empty slug" .) -}}
{{- end -}}
{{- $s -}}
{{- end -}}

{{/*
Resource name for a pool: collector-<slug>-<mode>.
Usage: include "collector.poolResourceName" $pool
*/}}
{{- define "collector.poolResourceName" -}}
{{- printf "collector-%s-%s" (include "collector.poolSlug" .name) .mode -}}
{{- end -}}

{{/*
Common labels for a pool's resources. Selector uses only "app" (immutable).
Usage: include "collector.poolLabels" (dict "root" $ "pool" $pool)
*/}}
{{- define "collector.poolLabels" -}}
app: {{ include "collector.poolResourceName" .pool }}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | replace "+" "_" }}
stratum.work/component: collector
stratum.work/site: {{ .root.Values.site | quote }}
stratum.work/pool: {{ include "collector.poolSlug" .pool.name }}
stratum.work/mode: {{ .pool.mode }}
{{- end -}}
