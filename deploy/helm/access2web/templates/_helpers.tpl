{{/* Labels on every object. */}}
{{- define "a2w.labels" -}}
app.kubernetes.io/name: access2web
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Labels that select the pods of one component. Call with (dict "root" . "component" "backend"). */}}
{{- define "a2w.selector" -}}
app.kubernetes.io/name: access2web
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/* The Secret that holds the database URL, under the key `url`. The chart makes it when it installs PostgreSQL. */}}
{{- define "a2w.databaseSecret" -}}
{{- if .Values.postgresql.enabled -}}{{ .Release.Name }}-database{{- else -}}{{ .Values.externalDatabase.existingSecret }}{{- end -}}
{{- end }}

{{/* Encodes a value for use in a URL. A space becomes %20, because in the userinfo part of a PostgreSQL URL a + is a plus sign. */}}
{{- define "a2w.urlenc" -}}
{{- . | urlquery | replace "+" "%20" -}}
{{- end }}
