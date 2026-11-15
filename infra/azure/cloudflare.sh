#!/usr/bin/env bash
# Cloudflare side of stage 3B: the four hostnames under CF_DOMAIN, in two parts that deploy.sh calls around the domain bind.
#
#   infra/azure/cloudflare.sh part1 [--dry-run]   TXT asuid.<host> (the environment's verification ID) and CNAME <host> -> the app's
#                                                 address, both DNS-only, so Azure's lookup sees them when a hostname is bound
#   infra/azure/cloudflare.sh part2 [--dry-run]   the four CNAMEs proxied, then ONE Configuration Rule for the four hostnames only
#                                                 (SSL strict, Rocket Loader off, email obfuscation off), then a read-only Web Analytics report
#
# --dry-run prints what would be written and makes no call at all (not even a read). Without it, a part first READS the zone, prints
# every change it will make, saves the zone's DNS records and rules to <workspace>/.local/tmp/cloudflare-before-<time>.json, and only
# then writes. Run directly (not by deploy.sh) it also waits for "yes" after printing the changes.
#
# It touches nothing but the four hostnames, their asuid TXT records and one rule of its own (ref mawsool_demo_hostnames); another
# record at one of those names (an A record, say) stops it, it never deletes. Other rules of the entry point are written back as read.
#
# The token (Zone DNS edit, Zone Config Rules edit) comes from CF_API_TOKEN in the environment, else azure.env, else
# <workspace>/.claude/settings.local.json under env (with CF_ACCOUNT_ID). It is passed to curl on stdin, so it never appears in a
# command line, and it is never printed. Without a token the changes are printed for entering by hand; CF_MANUAL_DONE=1 then lets
# the run go on. The zone id is CF_ZONE_ID, else looked up by CF_DOMAIN.
#
# Inputs set by deploy.sh (standalone they are worked out here): MAWSOOL_ENV_VERIFICATION_ID, MAWSOOL_HOST_{API,PERSON,CLINIC,OPS},
# MAWSOOL_FQDN_{API,PERSON,CLINIC,OPS} (each app's azurecontainerapps.io address). Needs bash 3.2+, curl and jq.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
WORKSPACE=$(dirname "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)")
ENV_FILE=${AZURE_ENV_FILE:-$WORKSPACE/.local/azure.env}
SETTINGS_FILE=${CF_SETTINGS_FILE:-$WORKSPACE/.claude/settings.local.json}
API=https://api.cloudflare.com/client/v4
RULE_REF=mawsool_demo_hostnames
RULE_PHASE=http_config_settings

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

PART=${1:-}
case "$PART" in part1 | part2) shift ;; -h | --help) sed -n '2,24p' "${BASH_SOURCE[0]}"; exit 0 ;; *) die "usage: cloudflare.sh part1|part2 [--dry-run]" ;; esac
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in --dry-run) DRY_RUN=1 ;; *) die "unknown option: $arg" ;; esac
done
command -v curl >/dev/null || die "curl is required"
command -v jq >/dev/null || die "jq is required"

# --- settings ------------------------------------------------------------------------------------------------------------
file_value() { # file_value <KEY>: the value after KEY= in azure.env (quotes removed), without sourcing the file
  local line
  [ -f "$ENV_FILE" ] || return 0
  line=$(grep -E "^$1=" "$ENV_FILE" | tail -1 || true)
  line=${line#*=}
  line=${line#\'}; line=${line%\'}
  line=${line#\"}; line=${line%\"}
  printf '%s' "$line"
}
CF_DOMAIN=${CF_DOMAIN:-$(file_value CF_DOMAIN)}
CF_DOMAIN=${CF_DOMAIN:-thevergara.dev}
HOST_API=${MAWSOOL_HOST_API:-mawsool-api.$CF_DOMAIN}
HOST_PERSON=${MAWSOOL_HOST_PERSON:-mawsool.$CF_DOMAIN}
HOST_CLINIC=${MAWSOOL_HOST_CLINIC:-mawsool-clinic.$CF_DOMAIN}
HOST_OPS=${MAWSOOL_HOST_OPS:-mawsool-ops.$CF_DOMAIN}

# Standalone, the apps' addresses and the verification ID are read from Azure (a dry run uses placeholders).
azure_value() { # azure_value <placeholder> <az args...>
  local placeholder=$1
  shift
  if [ "$DRY_RUN" = 1 ]; then printf '%s' "$placeholder"; else az "$@" -o tsv; fi
}
RG=${AZURE_RESOURCE_GROUP:-$(file_value AZURE_RESOURCE_GROUP)}
RG=${RG:-mawsool-demo-rg}
ENV_NAME=${ENV_NAME:-$(file_value ENV_NAME)}
ENV_NAME=${ENV_NAME:-mawsool-env}
app_fqdn() { azure_value "<$1-address>" containerapp show -n "$1" -g "$RG" --query properties.configuration.ingress.fqdn; }
FQDN_API=${MAWSOOL_FQDN_API:-$(app_fqdn mawsool-api)}
FQDN_PERSON=${MAWSOOL_FQDN_PERSON:-$(app_fqdn mawsool-person)}
FQDN_CLINIC=${MAWSOOL_FQDN_CLINIC:-$(app_fqdn mawsool-clinic)}
FQDN_OPS=${MAWSOOL_FQDN_OPS:-$(app_fqdn mawsool-ops)}
VERIFICATION_ID=${MAWSOOL_ENV_VERIFICATION_ID:-$(azure_value '<verification-id>' containerapp env show -n "$ENV_NAME" -g "$RG" --query properties.customDomainConfiguration.customDomainVerificationId)}

# host:address pairs, in the order the changes are listed.
PAIRS="$HOST_PERSON:$FQDN_PERSON $HOST_CLINIC:$FQDN_CLINIC $HOST_OPS:$FQDN_OPS $HOST_API:$FQDN_API"
host_expression() { # the rule's expression: exactly the four hostnames
  local pair out=''
  for pair in $PAIRS; do out="${out:+$out }\"${pair%%:*}\""; done
  printf '(http.host in {%s})' "$out"
}

# --- the printed change list (also the whole of a dry run) ---------------------------------------------------------------
print_desired() {
  local pair host
  say "== Cloudflare, zone $CF_DOMAIN, $PART"
  if [ "$PART" = part1 ]; then
    for pair in $PAIRS; do
      host=${pair%%:*}
      say "TXT    asuid.$host  =  <the environment's verification ID>  (DNS-only)"
      say "CNAME  $host  ->  ${pair#*:}  (DNS-only, so Azure's lookup sees the target)"
    done
  else
    for pair in $PAIRS; do say "CNAME  ${pair%%:*}  ->  ${pair#*:}  switched to proxied"; done
    say "Configuration Rule (phase $RULE_PHASE, ref $RULE_REF), the only rule this script writes:"
    say "  when $(host_expression)"
    say "  set ssl=strict, rocket_loader=false, email_obfuscation=false"
    say "Web Analytics: read-only; reports whether automatic injection is on for the zone and changes nothing"
  fi
}
if [ "$DRY_RUN" = 1 ]; then
  print_desired
  say "(dry run: no call was made to Cloudflare or Azure)"
  exit 0
fi

# --- the token ---------------------------------------------------------------------------------------------------------------
TOKEN=${CF_API_TOKEN:-$(file_value CF_API_TOKEN)}
ACCOUNT=${CF_ACCOUNT_ID:-$(file_value CF_ACCOUNT_ID)}
if [ -f "$SETTINGS_FILE" ]; then
  [ -n "$TOKEN" ] || TOKEN=$(jq -r '.env.CF_API_TOKEN // empty' "$SETTINGS_FILE")
  [ -n "$ACCOUNT" ] || ACCOUNT=$(jq -r '.env.CF_ACCOUNT_ID // empty' "$SETTINGS_FILE")
fi
if [ -z "$TOKEN" ]; then
  print_desired
  say "TXT value: $VERIFICATION_ID"
  say "no Cloudflare token found: enter the records and the rule above by hand."
  [ "${CF_MANUAL_DONE:-0}" = 1 ] && { say "CF_MANUAL_DONE=1: carrying on as if they were entered"; exit 0; }
  die "set CF_MANUAL_DONE=1 and run again once they are entered"
fi

# cf <METHOD> <path> [json body]: prints the response body, returns 1 when Cloudflare says success is false (errors go to stderr).
# The token is given to curl on stdin as a config line, never in its arguments.
cf() {
  local method=$1 path=$2 body=${3:-} out
  if [ -n "$body" ]; then
    out=$(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -sS -m 40 -K - -X "$method" -H 'content-type: application/json' --data "$body" "$API/$path") || return 1
  else
    out=$(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -sS -m 40 -K - -X "$method" "$API/$path") || return 1
  fi
  printf '%s' "$out"
  if [ "$(printf '%s' "$out" | jq -r '.success // false' 2>/dev/null)" != true ]; then
    printf '%s' "$out" | jq -r '.errors[]? | "cloudflare error \(.code): \(.message)"' >&2 2>/dev/null || true
    return 1
  fi
}

ZONE=${CF_ZONE_ID:-$(file_value CF_ZONE_ID)}
if [ -z "$ZONE" ]; then
  ZONE=$(cf GET "zones?name=$CF_DOMAIN" | jq -r '.result[0].id // empty') || die "cannot look up the zone $CF_DOMAIN; set CF_ZONE_ID"
  [ -n "$ZONE" ] || die "no zone named $CF_DOMAIN is visible to the token; set CF_ZONE_ID"
fi
DNS="zones/$ZONE/dns_records"

# --- reading and the plan -----------------------------------------------------------------------------------------------------
APPLY=0
CHANGES=0
# records_at <name>: every DNS record at exactly this name, as a JSON array.
records_at() { cf GET "$DNS?name=$1&per_page=100" | jq -c '.result'; }
# only_types <name> <records json> <type>: stop when a record of another type sits at the name (never deleted, never overwritten).
only_types() {
  local other
  other=$(printf '%s' "$2" | jq -r --arg t "$3" '[.[] | select(.type != $t) | .type] | join(",")')
  [ -z "$other" ] || die "$1 already has a $other record; this script only manages its own $3 record there. Remove it by hand if it is not needed."
  [ "$(printf '%s' "$2" | jq 'length')" -le 1 ] || die "$1 has more than one $3 record; not guessing which is ours"
}

# ensure_txt <name> <value>
ensure_txt() {
  local name=$1 value=$2 recs id current
  recs=$(records_at "$name")
  only_types "$name" "$recs" TXT
  id=$(printf '%s' "$recs" | jq -r '.[0].id // empty')
  current=$(printf '%s' "$recs" | jq -r '.[0].content // empty | sub("^\""; "") | sub("\"$"; "")')
  if [ -z "$id" ]; then
    say "CREATE  TXT    $name  (verification ID, DNS-only)"
    CHANGES=$((CHANGES + 1))
    [ "$APPLY" = 1 ] && cf POST "$DNS" "$(jq -nc --arg n "$name" --arg c "$value" '{type:"TXT",name:$n,content:$c,ttl:120,comment:"Mawsool demo, Azure custom-domain verification"}')" >/dev/null
  elif [ "$current" != "$value" ]; then
    say "UPDATE  TXT    $name  (new verification ID, DNS-only)"
    CHANGES=$((CHANGES + 1))
    [ "$APPLY" = 1 ] && cf PATCH "$DNS/$id" "$(jq -nc --arg c "$value" '{content:$c}')" >/dev/null
  else
    say "keep    TXT    $name"
  fi
  return 0
}

# ensure_cname <host> <target> <part>: part1 makes it exist and point at the target (a new record is DNS-only; an existing one with the
# right target keeps its proxy setting, so a rerun never takes a live hostname off the proxy); part2 makes it proxied.
ensure_cname() {
  local host=$1 target=$2 part=$3 recs id content proxied want_proxied
  recs=$(records_at "$host")
  only_types "$host" "$recs" CNAME
  id=$(printf '%s' "$recs" | jq -r '.[0].id // empty')
  content=$(printf '%s' "$recs" | jq -r '.[0].content // empty | ascii_downcase | sub("\\.$"; "")')
  proxied=$(printf '%s' "$recs" | jq -r '.[0].proxied // false')
  target=$(printf '%s' "$target" | tr '[:upper:]' '[:lower:]')
  if [ "$part" = part2 ]; then
    [ -n "$id" ] || die "$host has no CNAME; run part1 first"
    [ "$content" = "$target" ] || die "$host points at $content, not at $target; run part1 first"
    if [ "$proxied" = true ]; then
      say "keep    CNAME  $host  (already proxied)"
    else
      say "UPDATE  CNAME  $host  proxied=true"
      CHANGES=$((CHANGES + 1))
      [ "$APPLY" = 1 ] && cf PATCH "$DNS/$id" '{"proxied":true}' >/dev/null
    fi
    return 0
  fi
  if [ -z "$id" ]; then
    say "CREATE  CNAME  $host  ->  $target  (DNS-only)"
    CHANGES=$((CHANGES + 1))
    [ "$APPLY" = 1 ] && cf POST "$DNS" "$(jq -nc --arg n "$host" --arg c "$target" '{type:"CNAME",name:$n,content:$c,proxied:false,ttl:1,comment:"Mawsool demo"}')" >/dev/null
  elif [ "$content" != "$target" ]; then
    want_proxied=false
    say "UPDATE  CNAME  $host  $content -> $target  (DNS-only)"
    CHANGES=$((CHANGES + 1))
    [ "$APPLY" = 1 ] && cf PATCH "$DNS/$id" "$(jq -nc --arg c "$target" --argjson p "$want_proxied" '{content:$c,proxied:$p}')" >/dev/null
  else
    say "keep    CNAME  $host  (proxied=$proxied)"
  fi
  return 0
}

# ensure_rule: the zone's entry point ruleset for the config settings phase holds exactly its previous rules plus ours.
ensure_rule() {
  local expr desired current rules merged existing_ours existing_id others
  expr=$(host_expression)
  desired=$(jq -nc --arg ref "$RULE_REF" --arg e "$expr" '{ref:$ref, description:"Mawsool demo hostnames: strict SSL, no Rocket Loader, no email obfuscation", expression:$e, action:"set_config", action_parameters:{ssl:"strict", rocket_loader:false, email_obfuscation:false}, enabled:true}')
  # No entry point yet is a 404 from Cloudflare; that is the empty list.
  current=$(cf GET "zones/$ZONE/rulesets/phases/$RULE_PHASE/entrypoint" 2>/dev/null || true)
  rules=$(printf '%s' "$current" | jq -c '(.result.rules // []) | map({id, ref, description, expression, action, action_parameters, enabled} | with_entries(select(.value != null)))' 2>/dev/null || true)
  [ -n "$rules" ] || rules='[]'
  existing_ours=$(printf '%s' "$rules" | jq -c --arg ref "$RULE_REF" '[.[] | select(.ref == $ref)] | .[0] // empty')
  others=$(printf '%s' "$rules" | jq --arg ref "$RULE_REF" '[.[] | select(.ref != $ref)] | length')
  if [ -n "$existing_ours" ] && [ "$(printf '%s' "$existing_ours" | jq -c '{expression, action_parameters, enabled}')" = "$(printf '%s' "$desired" | jq -c '{expression, action_parameters, enabled}')" ]; then
    say "keep    rule $RULE_REF ($others other rule(s) in the zone's $RULE_PHASE entry point, untouched)"
    return 0
  fi
  say "$([ -n "$existing_ours" ] && echo UPDATE || echo CREATE)  rule $RULE_REF in the $RULE_PHASE entry point ($others other rule(s) kept as they are)"
  say "        $(printf '%s' "$desired" | jq -c '{expression, action_parameters}')"
  CHANGES=$((CHANGES + 1))
  if [ "$APPLY" = 1 ]; then
    existing_id=$(printf '%s' "$existing_ours" | jq -r '.id // empty' 2>/dev/null || true)
    [ -z "$existing_id" ] || desired=$(printf '%s' "$desired" | jq -c --arg id "$existing_id" '. + {id: $id}')
    merged=$(jq -nc --argjson rules "$rules" --argjson ours "$desired" --arg ref "$RULE_REF" '{rules: ([$rules[] | select(.ref != $ref)] + [$ours])}')
    cf PUT "zones/$ZONE/rulesets/phases/$RULE_PHASE/entrypoint" "$merged" >/dev/null
  fi
}

# web_analytics: read-only. The zone's automatic injection is one switch for the whole site and its per-host API has not been run
# against this account, so nothing is written here. It reports whether injection is on, so the page source of the four hostnames
# (a beacon.min.js script) can be checked after the run, and says what to do by hand if it is.
web_analytics() {
  local sites site auto
  if [ -z "$ACCOUNT" ]; then say "Web Analytics: no CF_ACCOUNT_ID, NOT CHECKED (check the page source of the four hostnames for beacon.min.js)"; return 0; fi
  sites=$(cf GET "accounts/$ACCOUNT/rum/site_info/list?per_page=100" 2>/dev/null) || { say "Web Analytics: the token cannot read it, NOT CHECKED (check the page source of the four hostnames for beacon.min.js)"; return 0; }
  site=$(printf '%s' "$sites" | jq -c --arg d "$CF_DOMAIN" '[.result[]? | select((.host // "") == $d or (.ruleset.zone_name // "") == $d)] | .[0] // empty')
  if [ -z "$site" ]; then say "Web Analytics: no site for $CF_DOMAIN, so nothing is injected"; return 0; fi
  auto=$(printf '%s' "$site" | jq -r '.auto_install // false')
  if [ "$auto" = true ]; then
    say "Web Analytics: automatic injection is ON for $CF_DOMAIN. NOT CHANGED: the four hostnames may get the beacon script, which the staff page policy"
    say "  would block. Check their page source after the run; to exclude them, add an exclusion per hostname in the dashboard (Web Analytics, the site's rules)."
  else
    say "Web Analytics: automatic injection is off for $CF_DOMAIN; the four hostnames get no beacon"
  fi
}

plan_and_apply() {
  local answer
  APPLY=0 CHANGES=0
  say "== Cloudflare, zone $CF_DOMAIN ($ZONE), $PART: what will change"
  run_all
  if [ "$CHANGES" = 0 ]; then say "nothing to change"; return 0; fi
  if [ -z "${MAWSOOL_FROM_DEPLOY:-}" ]; then
    printf 'Type yes to make these %s change(s) in Cloudflare: ' "$CHANGES"
    read -r answer
    [ "$answer" = yes ] || die "not confirmed"
  fi
  snapshot
  APPLY=1 CHANGES=0
  say "== writing"
  run_all
  say "done: $CHANGES change(s) written"
}
run_all() {
  local pair
  if [ "$PART" = part1 ]; then
    for pair in $PAIRS; do
      ensure_txt "asuid.${pair%%:*}" "$VERIFICATION_ID"
      ensure_cname "${pair%%:*}" "${pair#*:}" part1
    done
  else
    for pair in $PAIRS; do ensure_cname "${pair%%:*}" "${pair#*:}" part2; done
    ensure_rule
    web_analytics
  fi
}

# snapshot: the zone's DNS records and the config-settings entry point, as they are before the first write.
snapshot() {
  local dir=$WORKSPACE/.local/tmp file
  mkdir -p "$dir"
  file=$dir/cloudflare-before-$(date +%Y%m%d-%H%M%S).json
  jq -n --argjson dns "$(cf GET "$DNS?per_page=5000" | jq -c '.result')" \
    --argjson rules "$(cf GET "zones/$ZONE/rulesets/phases/$RULE_PHASE/entrypoint" 2>/dev/null | jq -c '.result // null' 2>/dev/null || echo null)" \
    '{dns_records: $dns, config_settings_entrypoint: $rules}' >"$file"
  chmod 600 "$file"
  say "saved the zone's records and rules before any change: $file"
}

plan_and_apply
