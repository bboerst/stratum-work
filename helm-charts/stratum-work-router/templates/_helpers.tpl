{{- define "stratum-work-router.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "stratum-work-router.fullname" -}}
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

{{- define "stratum-work-router.selectorLabels" -}}
app.kubernetes.io/name: {{ include "stratum-work-router.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "stratum-work-router.labels" -}}
{{ include "stratum-work-router.selectorLabels" . }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Port number from a ":port" / "host:port" listen string, with a default */}}
{{- define "stratum-work-router.portOf" -}}
{{- $addr := index . 0 | default "" | toString -}}
{{- $def := index . 1 -}}
{{- if $addr -}}
{{- $parts := splitList ":" $addr -}}
{{- last $parts | int -}}
{{- else -}}
{{- $def -}}
{{- end -}}
{{- end -}}

{{- define "stratum-work-router.stratumPort" -}}
{{- include "stratum-work-router.portOf" (list (.Values.config.listen | default "") 3333) -}}
{{- end -}}

{{- define "stratum-work-router.adminPort" -}}
{{- include "stratum-work-router.portOf" (list (.Values.config.adminListen | default "") 9100) -}}
{{- end -}}
