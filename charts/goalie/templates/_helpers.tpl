{{/* Expand the chart name. */}}
{{- define "goalie.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Create a release-scoped name. */}}
{{- define "goalie.fullname" -}}
{{- $name := .Chart.Name -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/* Chart identity labels. */}}
{{- define "goalie.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "goalie.selectorLabels" -}}
app.kubernetes.io/name: {{ include "goalie.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: app
{{- end -}}

{{- define "goalie.hookSelectorLabels" -}}
app.kubernetes.io/name: {{ include "goalie.name" .context }}
app.kubernetes.io/instance: {{ .context.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "goalie.hookLabels" -}}
helm.sh/chart: {{ include "goalie.chart" .context }}
{{ include "goalie.hookSelectorLabels" . }}
app.kubernetes.io/version: {{ .context.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .context.Release.Service }}
{{- end -}}

{{- define "goalie.labels" -}}
helm.sh/chart: {{ include "goalie.chart" . }}
{{ include "goalie.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Validate a Secret reference before any object is rendered. */}}
{{- define "goalie.validateSecretRef" -}}
{{- $ref := .ref -}}
{{- $path := .path -}}
{{- if not (kindIs "map" $ref) -}}
{{- fail (printf "%s must be an object with name and key" $path) -}}
{{- end -}}
{{- $name := default "" (get $ref "name") -}}
{{- $key := default "" (get $ref "key") -}}
{{- if or (not (kindIs "string" $name)) (eq (trim $name) "") -}}
{{- fail (printf "%s.name is required" $path) -}}
{{- end -}}
{{- if or (not (kindIs "string" $key)) (eq (trim $key) "") -}}
{{- fail (printf "%s.key is required" $path) -}}
{{- end -}}
{{- end -}}

{{/* Validate the application contract and reject unsafe combinations. */}}
{{- define "goalie.validate" -}}
{{- $values := .Values -}}
{{- $image := default (dict) $values.image -}}
{{- $app := default (dict) $values.app -}}
{{- $oidc := default (dict) $values.oidc -}}
{{- $database := default (dict) $values.database -}}
{{- $migration := default (dict) $values.migration -}}
{{- $openjev := default (dict) $values.openjev -}}
{{- $ingress := default (dict) $values.ingress -}}
{{- $pdb := default (dict) $values.pdb -}}

{{- $repository := default "" (get $image "repository") -}}
{{- if or (not (kindIs "string" $repository)) (eq (trim $repository) "") -}}
{{- fail "image.repository is required" -}}
{{- end -}}
{{- $digest := default "" (get $image "digest") -}}
{{- $tag := default "" (get $image "tag") -}}
{{- $pullPolicy := default "IfNotPresent" (get $image "pullPolicy") -}}
{{- if and (ne $digest "") (not (regexMatch "^sha256:[0-9a-f]{64}$" $digest)) -}}
{{- fail "image.digest must be a lowercase sha256: digest" -}}
{{- end -}}
{{- if not (has $pullPolicy (list "IfNotPresent" "Never")) -}}
{{- fail "image.pullPolicy must be IfNotPresent or Never" -}}
{{- end -}}
{{- if eq $digest "" -}}
{{- if or (not (kindIs "string" $tag)) (eq (trim $tag) "") (eq (lower $tag) "latest") -}}
{{- fail "image.tag is required and may not be latest when image.digest is empty" -}}
{{- end -}}
{{- if ne $pullPolicy "Never" -}}
{{- fail "image.pullPolicy must be Never when image.digest is empty" -}}
{{- end -}}
{{- end -}}

{{- $appURL := default "" (get $app "url") -}}
{{- if or (not (kindIs "string" $appURL)) (eq (trim $appURL) "") -}}
{{- fail "app.url is required" -}}
{{- end -}}
{{- $appParsed := urlParse $appURL -}}
{{- $appScheme := default "" (get $appParsed "scheme") -}}
{{- $appHost := default "" (get $appParsed "host") -}}
{{- $appPath := default "" (get $appParsed "path") -}}
{{- $appQuery := default "" (get $appParsed "query") -}}
{{- $appFragment := default "" (get $appParsed "fragment") -}}
{{- $appUserinfo := default "" (get $appParsed "userinfo") -}}
{{- if or (ne $appScheme "https") (eq $appHost "") (and (ne $appPath "") (ne $appPath "/")) (ne $appQuery "") (ne $appFragment "") (ne $appUserinfo "") -}}
{{- fail "app.url must be an HTTPS origin without credentials, query, fragment, or subpath" -}}
{{- end -}}

{{- $issuer := default "" (get $oidc "issuer") -}}
{{- if or (not (kindIs "string" $issuer)) (eq (trim $issuer) "") -}}
{{- fail "oidc.issuer is required" -}}
{{- end -}}
{{- $issuerParsed := urlParse $issuer -}}
{{- $issuerScheme := default "" (get $issuerParsed "scheme") -}}
{{- $issuerHost := default "" (get $issuerParsed "host") -}}
{{- $issuerQuery := default "" (get $issuerParsed "query") -}}
{{- $issuerFragment := default "" (get $issuerParsed "fragment") -}}
{{- $issuerUserinfo := default "" (get $issuerParsed "userinfo") -}}
{{- if or (ne $issuerScheme "https") (eq $issuerHost "") (ne $issuerQuery "") (ne $issuerFragment "") (ne $issuerUserinfo "") -}}
{{- fail "oidc.issuer must be an HTTPS URL without credentials, query, or fragment" -}}
{{- end -}}

{{- $clientID := default "" (get $oidc "clientId") -}}
{{- if or (not (kindIs "string" $clientID)) (eq (trim $clientID) "") -}}
{{- fail "oidc.clientId is required" -}}
{{- end -}}
{{ include "goalie.validateSecretRef" (dict "ref" (get $oidc "clientSecretRef") "path" "oidc.clientSecretRef") }}
{{ include "goalie.validateSecretRef" (dict "ref" (get $database "urlSecretRef") "path" "database.urlSecretRef") }}
{{- if hasKey $database "caSecretRef" -}}
{{- $caRef := get $database "caSecretRef" -}}
{{- if $caRef }}{{ include "goalie.validateSecretRef" (dict "ref" $caRef "path" "database.caSecretRef") }}{{- end -}}
{{- end -}}
{{- $trust := default (dict) $values.trust -}}
{{- if hasKey $trust "caSecretRef" -}}
{{- $trustRef := get $trust "caSecretRef" -}}
{{- if $trustRef }}{{ include "goalie.validateSecretRef" (dict "ref" $trustRef "path" "trust.caSecretRef") }}{{- end -}}
{{- end -}}

{{- $poolMax := int (default 10 (get $database "poolMax")) -}}
{{- if or (lt $poolMax 1) (gt $poolMax 100) -}}
{{- fail "database.poolMax must be between 1 and 100" -}}
{{- end -}}
{{- $bodyBytes := int (default 2000000 (get $app "maxRequestBodyBytes")) -}}
{{- if or (lt $bodyBytes 1024) (gt $bodyBytes 20000000) -}}
{{- fail "app.maxRequestBodyBytes must be between 1024 and 20000000" -}}
{{- end -}}

{{- $migrationURLRef := get $migration "urlSecretRef" -}}
{{- if $migrationURLRef }}{{ include "goalie.validateSecretRef" (dict "ref" $migrationURLRef "path" "migration.urlSecretRef") }}{{- end -}}

{{- if default false (get $openjev "enabled") -}}
{{- $baseURL := default "" (get $openjev "baseUrl") -}}
{{- $trustedOrigin := default "" (get $openjev "trustedOrigin") -}}
{{- if or (not (kindIs "string" $baseURL)) (eq (trim $baseURL) "") -}}
{{- fail "openjev.baseUrl is required when openjev.enabled is true" -}}
{{- end -}}
{{- if or (not (kindIs "string" $trustedOrigin)) (eq (trim $trustedOrigin) "") -}}
{{- fail "openjev.trustedOrigin is required when openjev.enabled is true" -}}
{{- end -}}
{{- $baseParsed := urlParse $baseURL -}}
{{- $baseScheme := default "" (get $baseParsed "scheme") -}}
{{- $baseHost := default "" (get $baseParsed "host") -}}
{{- $basePath := default "" (get $baseParsed "path") -}}
{{- $baseQuery := default "" (get $baseParsed "query") -}}
{{- $baseFragment := default "" (get $baseParsed "fragment") -}}
{{- $baseUserinfo := default "" (get $baseParsed "userinfo") -}}
{{- if or (ne $baseScheme "https") (eq $baseHost "") (and (ne $basePath "") (ne $basePath "/")) (ne $baseQuery "") (ne $baseFragment "") (ne $baseUserinfo "") -}}
{{- fail "openjev.baseUrl must be an HTTPS origin without credentials, query, fragment, or path" -}}
{{- end -}}
{{- $trustedParsed := urlParse $trustedOrigin -}}
{{- $trustedScheme := default "" (get $trustedParsed "scheme") -}}
{{- $trustedHost := default "" (get $trustedParsed "host") -}}
{{- $trustedPath := default "" (get $trustedParsed "path") -}}
{{- $trustedQuery := default "" (get $trustedParsed "query") -}}
{{- $trustedFragment := default "" (get $trustedParsed "fragment") -}}
{{- $trustedUserinfo := default "" (get $trustedParsed "userinfo") -}}
{{- if or (ne $trustedScheme "https") (eq $trustedHost "") (and (ne $trustedPath "") (ne $trustedPath "/")) (ne $trustedQuery "") (ne $trustedFragment "") (ne $trustedUserinfo "") (ne (lower $trustedHost) (lower $baseHost)) -}}
{{- fail "openjev.trustedOrigin must be the same HTTPS origin as openjev.baseUrl" -}}
{{- end -}}
{{- $timeout := int (default 30000 (get $openjev "timeoutMs")) -}}
{{- if or (lt $timeout 10) (gt $timeout 120000) -}}
{{- fail "openjev.timeoutMs must be between 10 and 120000" -}}
{{- end -}}
{{ include "goalie.validateSecretRef" (dict "ref" (get $openjev "apiKeySecretRef") "path" "openjev.apiKeySecretRef") }}
{{- end -}}

{{- if default false (get $ingress "enabled") -}}
{{- $className := default "" (get $ingress "className") -}}
{{- $ingressHost := default "" (get $ingress "host") -}}
{{- $tlsSecretName := default "" (get $ingress "tlsSecretName") -}}
{{- if eq (trim $className) "" }}{{ fail "ingress.className is required when ingress.enabled is true" }}{{ end -}}
{{- if eq (trim $ingressHost) "" }}{{ fail "ingress.host is required when ingress.enabled is true" }}{{ end -}}
{{- if eq (trim $tlsSecretName) "" }}{{ fail "ingress.tlsSecretName is required when ingress.enabled is true" }}{{ end -}}
{{- if not (regexMatch "^[A-Za-z0-9.-]+$" $ingressHost) }}{{ fail "ingress.host must be a DNS host without a port or path" }}{{ end -}}
{{- if ne (lower $ingressHost) (lower $appHost) }}{{ fail "ingress.host must match the host in app.url" }}{{ end -}}
{{- end -}}

{{- if default false (get $pdb "enabled") -}}
{{- $replicas := int (default 1 $values.replicaCount) -}}
{{- if lt $replicas 2 }}{{ fail "pdb.enabled requires replicaCount >= 2" }}{{ end }}
{{- end -}}
{{- end -}}

{{/* Render the immutable image reference. */}}
{{- define "goalie.image" -}}
{{- $image := default (dict) .Values.image -}}
{{- $repo := required "image.repository is required" (get $image "repository") -}}
{{- $digest := default "" (get $image "digest") -}}
{{- if $digest -}}{{ printf "%s@%s" $repo $digest }}{{- else -}}{{ printf "%s:%s" $repo (get $image "tag") }}{{- end -}}
{{- end -}}

{{- define "goalie.imagePullPolicy" -}}
{{- default "IfNotPresent" (get (default (dict) .Values.image) "pullPolicy") -}}
{{- end -}}

{{- define "goalie.imagePullSecrets" -}}
{{- range $secret := .Values.imagePullSecrets }}
- name: {{ required "imagePullSecrets entries require name" (get $secret "name") | quote }}
{{- end -}}
{{- end -}}
