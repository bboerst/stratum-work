{{- define "stratum-work-stream.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "stratum-work-stream.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "stratum-work-stream.mode" -}}
{{- if not (has .Values.mode (list "stream" "ingest")) -}}
{{- fail (printf "mode must be \"stream\" or \"ingest\", got %q" (toString .Values.mode)) -}}
{{- end -}}
{{- .Values.mode -}}
{{- end -}}

{{- define "stratum-work-stream.selectorLabels" -}}
app.kubernetes.io/name: {{ include "stratum-work-stream.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: {{ include "stratum-work-stream.mode" . }}
{{- end -}}

{{- define "stratum-work-stream.labels" -}}
{{ include "stratum-work-stream.selectorLabels" . }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
