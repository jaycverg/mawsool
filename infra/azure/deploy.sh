#!/usr/bin/env bash
# Deploys the Mawsool demo to Azure: a Container Apps environment with four apps, a PostgreSQL Flexible Server and a registry.
#
#   infra/azure/deploy.sh --init       create <workspace>/.local/azure.env and fill its secrets (nothing is printed)
#   infra/azure/deploy.sh --check      read-only: login, subscription, providers, names, region (changes nothing)
#   infra/azure/deploy.sh --dry-run    print every step and command it would run, with no call to Azure at all
#   infra/azure/deploy.sh --probe=URL  read-only: say whether the API at URL is "seeded", "empty" or "unknown" (no Azure, no settings)
#   infra/azure/deploy.sh [--yes]      deploy (asks for "yes" first unless --yes); safe to run again
#
# Settings come from azure.env (see azure.env.example): EDGE=azure|cloudflare picks the stage, AI=on|off the summary assistant.
#   EDGE=azure       stage 3A: the apps keep their azurecontainerapps.io addresses and their ingress stays open.
#   EDGE=cloudflare  stage 3B: the four hostnames under CF_DOMAIN, bound with a Cloudflare Origin CA certificate, then the
#                    ingress is locked to Cloudflare's addresses. Needs infra/azure/cloudflare.sh (not written yet).
#
# It prints names and URLs, never a secret: every command is shown with secret values replaced by ***, nothing runs under
# `set -x`, and every az call that creates or changes something runs with `-o none`, because some of them print what they were
# given (az 2.92 `postgres flexible-server create` returns the admin password and a full connection string in its result). A step that already holds (the resource exists, the image tag is pushed) is skipped, so a rerun picks up where a
# failed run stopped and a redeploy only replaces what changed. Written for bash 3.2 (macOS) and later.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
# The workspace root holds .local. In a linked worktree that is the main checkout, the parent of the shared .git directory.
WORKSPACE=$(dirname "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)")
ENV_FILE=${AZURE_ENV_FILE:-$WORKSPACE/.local/azure.env}

MODE=deploy
DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --init) MODE=init ;;
    --check) MODE=check ;;
    --probe=*) MODE=probe; PROBE_URL=${arg#--probe=} ;;
    --dry-run) DRY_RUN=1 ;;
    --yes) ASSUME_YES=1 ;;
    -h | --help) sed -n '2,21p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

export AZURE_CORE_DISABLE_CONFIRM_PROMPT=1 AZURE_EXTENSION_USE_DYNAMIC_INSTALL=yes_without_prompt

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- secrets never reach the screen ---------------------------------------------------------------------------------
SECRETS=()
remember_secret() { [ -n "${1:-}" ] && SECRETS+=("$1"); return 0; }
redact() {
  local text=$1 value
  for value in ${SECRETS[@]+"${SECRETS[@]}"}; do text=${text//"$value"/***}; done
  printf '%s' "$text"
}
show_command() {
  local out='+' arg
  for arg in "$@"; do
    arg=$(redact "$arg")
    case "$arg" in
      '' | *[!A-Za-z0-9_@%+=:,./\<\>-]*) out+=" '${arg//\'/\'\\\'\'}'" ;;
      *) out+=" $arg" ;;
    esac
  done
  printf '%s\n' "$out"
}
# scrub: copies stdin to stdout with every remembered secret replaced. A second line of defence: the az calls that change
# something also run with `-o none`, so they print no result at all.
scrub() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s\n' "$(redact "$line")"
  done
}
# run: show a command, then run it unless this is a dry run. What it prints passes through scrub.
run() {
  show_command "$@"
  [ "$DRY_RUN" = 1 ] && return 0
  "$@" 2>&1 | scrub
}
# retry <tries> <seconds> <command...>: for calls that fail until a role assignment or a DNS record has spread.
retry() {
  local tries=$1 pause=$2 n=1
  shift 2
  show_command "$@"
  [ "$DRY_RUN" = 1 ] && return 0
  until "$@" 2>&1 | scrub; do
    [ "$n" -ge "$tries" ] && return 1
    say "  not yet (attempt $n of $tries); waiting ${pause}s"
    n=$((n + 1))
    sleep "$pause"
  done
}
# read_value <placeholder> <command...>: print a value read from Azure, or the placeholder in a dry run.
read_value() {
  local placeholder=$1
  shift
  if [ "$DRY_RUN" = 1 ]; then printf '%s' "$placeholder"; else "$@"; fi
}
# exists <command...>: true when a show command succeeds. In a dry run nothing exists, so every create is listed.
exists() {
  [ "$DRY_RUN" = 1 ] && return 1
  "$@" >/dev/null 2>&1
}

# --- the settings file -------------------------------------------------------------------------------------------------
value_in_file() { # value_in_file <KEY>: the value after KEY= (quotes removed), without sourcing the file
  local line
  line=$(grep -E "^$1=" "$ENV_FILE" | tail -1 || true)
  line=${line#*=}
  line=${line#\'}; line=${line%\'}
  line=${line#\"}; line=${line%\"}
  printf '%s' "$line"
}
set_in_file() { # set_in_file <KEY> <value>: replaces or appends the line, keeping every other line as it is
  local tmp
  tmp=$(mktemp "$ENV_FILE.XXXXXX")
  grep -vE "^$1=" "$ENV_FILE" >"$tmp" || true
  printf "%s='%s'\n" "$1" "$2" >>"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}
generate() {
  case "$1" in
    BUNDLE_ENCRYPTION_KEY) openssl rand -base64 32 ;;
    INBOUND_KEY_*) openssl rand -hex 24 ;;
    POSTGRES_ADMIN_PASSWORD) printf 'Mw9%s' "$(openssl rand -hex 16)" ;; # upper, lower and digit, letters and digits only (it goes in a URL)
  esac
}
init_env_file() {
  mkdir -p "$(dirname "$ENV_FILE")"
  if [ ! -f "$ENV_FILE" ]; then
    cp "$HERE/azure.env.example" "$ENV_FILE"
    say "created $ENV_FILE from azure.env.example"
  fi
  chmod 600 "$ENV_FILE"
  local key
  for key in BUNDLE_ENCRYPTION_KEY INBOUND_KEY_TAMM INBOUND_KEY_PHC INBOUND_KEY_SCHOOL POSTGRES_ADMIN_PASSWORD; do
    if [ -z "$(value_in_file "$key")" ]; then
      set_in_file "$key" "$(generate "$key")"
      say "generated $key (value not shown)"
    else
      say "kept $key (already set)"
    fi
  done
  for key in AZURE_SUBSCRIPTION AZURE_LOCATION AZURE_RESOURCE_GROUP EDGE AI; do
    if [ -z "$(value_in_file "$key")" ]; then
      case "$key" in
        AZURE_SUBSCRIPTION) set_in_file "$key" 'Azure subscription 1' ;;
        AZURE_LOCATION) set_in_file "$key" uaenorth ;;
        AZURE_RESOURCE_GROUP) set_in_file "$key" mawsool-demo-rg ;;
        EDGE) set_in_file "$key" azure ;;
        AI) set_in_file "$key" off ;;
      esac
      say "set $key to its default"
    fi
  done
  say "file mode: $(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE")"
}

if [ "$MODE" = init ]; then
  init_env_file
  exit 0
fi

# --- is the database seeded? ----------------------------------------------------------------------------------------------
# What Fastify answers to a route it does not have, which is also what the guest sign-in answers for a demo account that is not
# in the database. A 404 from the Container Apps front end (during a revision swap, say) has some other body.
FASTIFY_NOT_FOUND='{"message":"Route POST:/demo/guest-session not found","error":"Not Found","statusCode":404}'
# seed_state <api-url>: prints "seeded" (the demo admin can sign in), "empty" (all of: the API says it is a demo, its directory
# of services is an empty list, and the guest sign-in gives Fastify's own not-found body) or "unknown" (anything else, which
# is never a reason to seed).
seed_state() {
  local clock services services_status guest guest_status guest_body
  clock=$(curl -s -m 30 "$1/clock" || true)
  case "$clock" in *'"demoMode":true'*) ;; *) echo unknown; return 0 ;; esac
  guest=$(curl -s -m 30 -w '\n%{http_code}' -X POST -H 'content-type: application/json' -d '{"email":"admin@demo.mawsool.test"}' "$1/demo/guest-session" || true)
  guest_status=${guest##*$'\n'}
  guest_body=${guest%$'\n'*}
  if [ "$guest_status" = 200 ]; then echo seeded; return 0; fi
  [ "$guest_status" = 404 ] && [ "$guest_body" = "$FASTIFY_NOT_FOUND" ] || { echo unknown; return 0; }
  services=$(curl -s -m 30 -w '\n%{http_code}' "$1/services" || true)
  services_status=${services##*$'\n'}
  [ "$services_status" = 200 ] && [ "${services%$'\n'*}" = '[]' ] || { echo unknown; return 0; }
  echo empty
}
if [ "$MODE" = probe ]; then
  seed_state "$PROBE_URL"
  exit 0
fi

[ -f "$ENV_FILE" ] || die "$ENV_FILE does not exist; run: infra/azure/deploy.sh --init"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

AZURE_SUBSCRIPTION=${AZURE_SUBSCRIPTION:-Azure subscription 1}
AZURE_LOCATION=${AZURE_LOCATION:-uaenorth}
# The database may sit in another region: Flexible Server SKUs are refused per subscription and region.
PG_LOCATION=${PG_LOCATION:-$AZURE_LOCATION}
# acr: one ACR Tasks run builds the images. local: Docker builds them here and pushes (for a subscription where ACR Tasks is refused).
IMAGE_BUILD=${IMAGE_BUILD:-acr}
case "$IMAGE_BUILD" in acr|local) ;; *) die "IMAGE_BUILD must be acr or local" ;; esac
AZURE_RESOURCE_GROUP=${AZURE_RESOURCE_GROUP:-mawsool-demo-rg}
EDGE=${EDGE:-azure}
AI=${AI:-off}
CF_DOMAIN=${CF_DOMAIN:-thevergara.dev}
case "$EDGE" in azure | cloudflare) ;; *) die "EDGE must be azure or cloudflare" ;; esac
case "$AI" in on | off) ;; *) die "AI must be on or off" ;; esac

for secret in "${BUNDLE_ENCRYPTION_KEY:-}" "${INBOUND_KEY_TAMM:-}" "${INBOUND_KEY_PHC:-}" "${INBOUND_KEY_SCHOOL:-}" "${POSTGRES_ADMIN_PASSWORD:-}" "${ANTHROPIC_API_KEY:-}"; do
  remember_secret "$secret"
done

# --- names --------------------------------------------------------------------------------------------------------------
APP_API=mawsool-api
APP_PERSON=mawsool-person
APP_CLINIC=mawsool-clinic
APP_OPS=mawsool-ops
ENV_NAME=${ENV_NAME:-mawsool-env}
IDENTITY_NAME=mawsool-pull
PG_ADMIN_USER=mawsooladmin
PG_DATABASE=mawsool
CERT_NAME=mawsool-origin-ca
HOST_API=mawsool-api.$CF_DOMAIN
HOST_PERSON=mawsool.$CF_DOMAIN
HOST_CLINIC=mawsool-clinic.$CF_DOMAIN
HOST_OPS=mawsool-ops.$CF_DOMAIN

# --- preflight: everything that can be checked without creating anything ------------------------------------------------
preflight_settings() {
  local missing='' key
  for key in BUNDLE_ENCRYPTION_KEY INBOUND_KEY_TAMM INBOUND_KEY_PHC INBOUND_KEY_SCHOOL POSTGRES_ADMIN_PASSWORD; do
    [ -n "${!key:-}" ] || missing="$missing $key"
  done
  [ "$AI" = on ] && [ -z "${ANTHROPIC_API_KEY:-}" ] && missing="$missing ANTHROPIC_API_KEY"
  if [ "$EDGE" = cloudflare ]; then
    for key in ORIGIN_CERT_FILE ORIGIN_KEY_FILE; do
      [ -n "${!key:-}" ] || missing="$missing $key"
    done
  fi
  [ -z "$missing" ] || die "missing in $ENV_FILE:$missing (run --init for the generated ones)"

  # A key copied from .env.example is public: refuse it. The comparison is made in memory and nothing is printed.
  local example
  for key in BUNDLE_ENCRYPTION_KEY INBOUND_KEY_TAMM INBOUND_KEY_PHC INBOUND_KEY_SCHOOL; do
    example=$(grep -E "^$key=" "$REPO/.env.example" | head -1 | cut -d= -f2- || true)
    [ -n "$example" ] && [ "${!key}" = "$example" ] && die "$key equals the value in .env.example, which is public; generate your own (--init)"
  done
  # What the API itself refuses at start-up, so a bad value stops here and not in a restart loop.
  [ "$(printf '%s' "$BUNDLE_ENCRYPTION_KEY" | base64 -d 2>/dev/null | wc -c | tr -d ' ')" = 32 ] || die "BUNDLE_ENCRYPTION_KEY must be 32 random bytes as base64"
  for key in INBOUND_KEY_TAMM INBOUND_KEY_PHC INBOUND_KEY_SCHOOL; do
    [ "$(printf '%s' "${!key}" | wc -c | tr -d ' ')" -ge 32 ] || die "$key must be at least 32 characters"
  done
  # Azure's password rule (three of four classes, 8 to 128), kept to letters and digits so it can sit in a URL unescaped.
  printf '%s' "$POSTGRES_ADMIN_PASSWORD" | grep -Eq '^[A-Za-z0-9]{16,}$' || die "POSTGRES_ADMIN_PASSWORD must be 16 or more letters and digits"
  local class
  for class in '[A-Z]' '[a-z]' '[0-9]'; do
    printf '%s' "$POSTGRES_ADMIN_PASSWORD" | grep -q "$class" || die "POSTGRES_ADMIN_PASSWORD must hold an upper-case letter, a lower-case letter and a digit"
  done
  if [ "$EDGE" = cloudflare ] && [ "$DRY_RUN" = 0 ]; then
    [ -f "$ORIGIN_CERT_FILE" ] && [ -f "$ORIGIN_KEY_FILE" ] || die "the Origin CA certificate or key file does not exist"
    [ -x "$HERE/cloudflare.sh" ] || die "EDGE=cloudflare needs infra/azure/cloudflare.sh, which is stage 3B work and is not written yet"
  fi
  command -v git >/dev/null || die "git is required"
  command -v curl >/dev/null || die "curl is required"
  command -v openssl >/dev/null || die "openssl is required"
  if [ "$DRY_RUN" = 0 ]; then
    command -v az >/dev/null || die "the Azure CLI (az) is required"
    local current
    current=$(az account show --query name -o tsv 2>/dev/null) || die "not logged in to Azure: run az login"
    [ "$current" = "$AZURE_SUBSCRIPTION" ] || die "az is using the subscription \"$current\", not \"$AZURE_SUBSCRIPTION\"; run: az account set --subscription \"$AZURE_SUBSCRIPTION\""
  fi
}
preflight_settings

if [ "$DRY_RUN" = 1 ]; then SUB_ID=00000000-0000-0000-0000-000000000000; else SUB_ID=$(az account show --query id -o tsv); fi
# Globally unique names are derived from the subscription, so a rerun finds the same resources.
SUFFIX=$(printf '%s' "$SUB_ID" | shasum -a 256 | cut -c1-6)
ACR_NAME=${ACR_NAME:-mawsool$SUFFIX}
PG_SERVER_NAME=${PG_SERVER_NAME:-mawsool-pg-$SUFFIX}
ACR_SERVER=$ACR_NAME.azurecr.io
PG_HOST=$PG_SERVER_NAME.postgres.database.azure.com
GIT_SHA=$(git -C "$REPO" rev-parse --short=10 HEAD)

REQUIRED_PROVIDERS="Microsoft.App Microsoft.OperationalInsights Microsoft.DBforPostgreSQL Microsoft.ContainerRegistry Microsoft.ManagedIdentity"

print_plan() {
  step "Plan"
  say "subscription     $AZURE_SUBSCRIPTION ($SUB_ID)"
  say "resource group   $AZURE_RESOURCE_GROUP in $AZURE_LOCATION"
  say "stage            EDGE=$EDGE, AI=$AI"
  say "registry         $ACR_NAME (Basic)"
  say "environment      $ENV_NAME"
  say "postgres         $PG_SERVER_NAME in $PG_LOCATION (Burstable B1ms, PostgreSQL 17, database $PG_DATABASE, firewall: Azure services only)"
  say "apps             $APP_API (1 replica), $APP_PERSON, $APP_CLINIC, $APP_OPS (0 to 1 replica)"
  say "api settings     DEMO_MODE=true RATE_LIMIT=true DEMO_RESET_COOLDOWN_MS=300000 DEMO_RESET_CRON='0 23 * * *' SUMMARY_DAILY_LIMIT=100 SUMMARY_LLM_ENABLED=$([ "$AI" = on ] && echo true || echo false)"
  if [ "$EDGE" = cloudflare ]; then
    say "client address   CLIENT_IP_HEADER=cf-connecting-ip"
    say "hostnames        $HOST_PERSON  $HOST_CLINIC  $HOST_OPS  $HOST_API"
  else
    say "client address   CLIENT_IP_HEADER unset (every limit is one cap shared by all visitors)"
  fi
  say "image source     git commit $GIT_SHA (committed files only)"
}

# --- --check: read-only ---------------------------------------------------------------------------------------------------
if [ "$MODE" = check ]; then
  [ "$DRY_RUN" = 0 ] || die "--check reads from Azure; it cannot be a dry run"
  print_plan
  step "Providers (a deploy registers any that is not Registered)"
  for ns in $REQUIRED_PROVIDERS; do say "$ns  $(az provider show -n "$ns" --query registrationState -o tsv)"; done
  step "Region $AZURE_LOCATION"
  say "Container Apps environments: $(az provider show -n Microsoft.App --query "resourceTypes[?resourceType=='managedEnvironments'].locations | [0] | contains(@, '$(az account list-locations --query "[?name=='$AZURE_LOCATION'].displayName | [0]" -o tsv)')" -o tsv)"
  say "PostgreSQL B1ms and 17 in $PG_LOCATION: $(az postgres flexible-server list-skus -l "$PG_LOCATION" --query "[0].supportedServerEditions[?name=='Burstable'].supportedServerSkus[].name | [?@=='Standard_B1ms'] | [0]" -o tsv 2>/dev/null)"
  step "Names"
  say "registry $ACR_NAME: $(az acr check-name -n "$ACR_NAME" --query 'nameAvailable' -o tsv 2>/dev/null || echo unknown) (true = free; false is fine if it is already ours)"
  say "resource group $AZURE_RESOURCE_GROUP exists: $(az group exists -n "$AZURE_RESOURCE_GROUP")"
  exit 0
fi

# --- confirmation ---------------------------------------------------------------------------------------------------------
print_plan
if [ "$DRY_RUN" = 0 ] && [ "$ASSUME_YES" = 0 ]; then
  say ""
  say "This creates or changes Azure resources, and public addresses, in the subscription above."
  printf 'Type yes to go on: '
  read -r answer
  [ "$answer" = yes ] || die "not confirmed"
fi
[ "$DRY_RUN" = 0 ] || say "(dry run: nothing below is sent to Azure; values read from Azure show as <placeholders>)"

WORK=$(mktemp -d)
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# --- 1. providers ---------------------------------------------------------------------------------------------------------
step "1. Resource providers"
for ns in $REQUIRED_PROVIDERS; do
  state=$(read_value Unregistered az provider show -n "$ns" --query registrationState -o tsv)
  if [ "$state" = Registered ]; then say "$ns is registered"; else run az provider register -n "$ns" --wait -o none; fi
done

# --- 2. resource group ----------------------------------------------------------------------------------------------------
step "2. Resource group"
if exists az group show -n "$AZURE_RESOURCE_GROUP"; then say "$AZURE_RESOURCE_GROUP exists"; else run az group create -n "$AZURE_RESOURCE_GROUP" -l "$AZURE_LOCATION" -o none; fi

# --- 3. container registry ------------------------------------------------------------------------------------------------
step "3. Container Registry (Basic)"
if exists az acr show -n "$ACR_NAME" -g "$AZURE_RESOURCE_GROUP"; then
  say "$ACR_NAME exists"
else
  if [ "$DRY_RUN" = 0 ]; then
    [ "$(az acr check-name -n "$ACR_NAME" --query nameAvailable -o tsv)" = true ] || die "the registry name $ACR_NAME is taken by someone else; set ACR_NAME in $ENV_FILE"
  fi
  run az acr create -n "$ACR_NAME" -g "$AZURE_RESOURCE_GROUP" -l "$AZURE_LOCATION" --sku Basic --admin-enabled false -o none
fi

# --- 4. identity that pulls images -----------------------------------------------------------------------------------------
step "4. Managed identity with AcrPull on the registry"
if exists az identity show -n "$IDENTITY_NAME" -g "$AZURE_RESOURCE_GROUP"; then say "$IDENTITY_NAME exists"; else run az identity create -n "$IDENTITY_NAME" -g "$AZURE_RESOURCE_GROUP" -l "$AZURE_LOCATION" -o none; fi
IDENTITY_ID=$(read_value '<identity-id>' az identity show -n "$IDENTITY_NAME" -g "$AZURE_RESOURCE_GROUP" --query id -o tsv)
IDENTITY_PRINCIPAL=$(read_value '<identity-principal>' az identity show -n "$IDENTITY_NAME" -g "$AZURE_RESOURCE_GROUP" --query principalId -o tsv)
ACR_ID=$(read_value '<registry-id>' az acr show -n "$ACR_NAME" -g "$AZURE_RESOURCE_GROUP" --query id -o tsv)
if [ "$DRY_RUN" = 0 ] && [ -n "$(az role assignment list --assignee "$IDENTITY_PRINCIPAL" --scope "$ACR_ID" --role AcrPull --query '[0].id' -o tsv)" ]; then
  say "AcrPull is already granted"
else
  run az role assignment create --assignee-object-id "$IDENTITY_PRINCIPAL" --assignee-principal-type ServicePrincipal --role AcrPull --scope "$ACR_ID" -o none
fi

# --- 5. container apps environment ---------------------------------------------------------------------------------------------
step "5. Container Apps environment"
if exists az containerapp env show -n "$ENV_NAME" -g "$AZURE_RESOURCE_GROUP"; then say "$ENV_NAME exists"; else run az containerapp env create -n "$ENV_NAME" -g "$AZURE_RESOURCE_GROUP" -l "$AZURE_LOCATION" -o none; fi
DEFAULT_DOMAIN=$(read_value '<environment-default-domain>' az containerapp env show -n "$ENV_NAME" -g "$AZURE_RESOURCE_GROUP" --query properties.defaultDomain -o tsv)
VERIFICATION_ID=$(read_value '<verification-id>' az containerapp env show -n "$ENV_NAME" -g "$AZURE_RESOURCE_GROUP" --query properties.customDomainConfiguration.customDomainVerificationId -o tsv)
say "default domain: $DEFAULT_DOMAIN"
[ "$EDGE" = cloudflare ] && say "custom domain verification ID: $VERIFICATION_ID"

# What each app is called on the web. The API address is fixed into the images, so it has to be known before they are built.
if [ "$EDGE" = azure ]; then
  URL_API=https://$APP_API.$DEFAULT_DOMAIN
  URL_PERSON=https://$APP_PERSON.$DEFAULT_DOMAIN
  URL_CLINIC=https://$APP_CLINIC.$DEFAULT_DOMAIN
  URL_OPS=https://$APP_OPS.$DEFAULT_DOMAIN
else
  URL_API=https://$HOST_API
  URL_PERSON=https://$HOST_PERSON
  URL_CLINIC=https://$HOST_CLINIC
  URL_OPS=https://$HOST_OPS
fi
say "API address in the images: $URL_API"

# --- 6. postgres -------------------------------------------------------------------------------------------------------------
step "6. PostgreSQL Flexible Server (Burstable B1ms, 17, in $PG_LOCATION)"
if exists az postgres flexible-server show -n "$PG_SERVER_NAME" -g "$AZURE_RESOURCE_GROUP"; then
  say "$PG_SERVER_NAME exists"
else
  # --public-access 0.0.0.0 is the "allow Azure services" rule and nothing else.
  run az postgres flexible-server create -n "$PG_SERVER_NAME" -g "$AZURE_RESOURCE_GROUP" -l "$PG_LOCATION" \
    --tier Burstable --sku-name Standard_B1ms --version 17 --storage-size 32 --backup-retention 7 \
    --admin-user "$PG_ADMIN_USER" --admin-password "$POSTGRES_ADMIN_PASSWORD" --public-access 0.0.0.0 --yes -o none
fi
if exists az postgres flexible-server db show --server-name "$PG_SERVER_NAME" -g "$AZURE_RESOURCE_GROUP" --name "$PG_DATABASE"; then
  say "database $PG_DATABASE exists"
elif [ "$DRY_RUN" = 0 ]; then
  run az postgres flexible-server db create --server-name "$PG_SERVER_NAME" -g "$AZURE_RESOURCE_GROUP" --name "$PG_DATABASE" -o none
fi
# sslmode=require is the Flexible Server's own requirement. If pg, the migrator or pg-boss refuse it, the fallback is a
# DATABASE_SSL option in the API (see README); nothing here works around it.
DATABASE_URL="postgres://$PG_ADMIN_USER:$POSTGRES_ADMIN_PASSWORD@$PG_HOST:5432/$PG_DATABASE?sslmode=require"
remember_secret "$DATABASE_URL"

# --- 7. images ---------------------------------------------------------------------------------------------------------------
step "7. Images (one ACR run builds and pushes the four)"
# The tag holds the commit and a hash of the API address, because the address is built into the images: the same commit rebuilt
# for another address is another image.
TAG=$GIT_SHA-$(printf '%s' "$URL_API" | shasum -a 256 | cut -c1-6)
say "tag: $TAG"
if [ -n "$(git -C "$REPO" status --porcelain)" ]; then say "note: uncommitted changes are NOT in the images; they are built from commit $GIT_SHA"; fi
have_images=0
if [ "$DRY_RUN" = 0 ]; then
  have_images=1
  for repo in mawsool-api mawsool-person mawsool-clinician mawsool-ops; do
    az acr repository show-tags -n "$ACR_NAME" --repository "$repo" -o tsv 2>/dev/null | grep -qx "$TAG" || have_images=0
  done
fi
if [ "$have_images" = 1 ]; then
  say "all four images are already in $ACR_NAME with tag $TAG"
else
  if [ "$DRY_RUN" = 0 ]; then
    mkdir -p "$WORK/context"
    git -C "$REPO" archive HEAD | tar -x -C "$WORK/context"
  fi
  if [ "$IMAGE_BUILD" = local ]; then
    # ACR Tasks is refused on some subscriptions (free trials: TasksOperationsNotAllowed). The same four builds run here
    # with Docker for linux/amd64 and are pushed with the registry's own login; a push is not an ACR Task.
    run az acr login -n "$ACR_NAME"
    for target in api person clinician ops; do
      image=$ACR_SERVER/mawsool-$target:$TAG
      run docker build --platform linux/amd64 --target "$target" -t "$image" \
        --build-arg "NEXT_PUBLIC_API_URL=$URL_API" --build-arg NEXT_PUBLIC_PUBLIC_DEMO=true -f "$WORK/context/Dockerfile" "$WORK/context"
      run docker push "$image"
    done
  else
    run az acr run -r "$ACR_NAME" --timeout 3600 --file infra/azure/acr-task.yaml --set "TAG=$TAG" --set "NEXT_PUBLIC_API_URL=$URL_API" "$WORK/context"
  fi
  if [ "$DRY_RUN" = 0 ]; then
    for repo in mawsool-api mawsool-person mawsool-clinician mawsool-ops; do
      az acr repository show-tags -n "$ACR_NAME" --repository "$repo" -o tsv | grep -qx "$TAG" || die "the ACR run did not push $repo:$TAG"
      say "pushed $ACR_SERVER/$repo:$TAG"
    done
  fi
fi

# --- 8. apps -------------------------------------------------------------------------------------------------------------------
step "8. Container Apps (single revision mode)"
CORS_ORIGINS="$URL_PERSON,$URL_CLINIC,$URL_OPS"
API_ENV=(
  "DATABASE_URL=secretref:database-url"
  "BUNDLE_ENCRYPTION_KEY=secretref:bundle-encryption-key"
  "INBOUND_KEY_TAMM=secretref:inbound-key-tamm"
  "INBOUND_KEY_PHC=secretref:inbound-key-phc"
  "INBOUND_KEY_SCHOOL=secretref:inbound-key-school"
  "DEMO_MODE=true"
  "RATE_LIMIT=true"
  "DEMO_RESET_COOLDOWN_MS=300000"
  "DEMO_RESET_CRON=0 23 * * *"
  "SUMMARY_DAILY_LIMIT=100"
  "CORS_ORIGINS=$CORS_ORIGINS"
  "PERSON_APP_URL=$URL_PERSON"
  "CLINICIAN_APP_URL=$URL_CLINIC"
  "OPS_APP_URL=$URL_OPS"
)
API_SECRETS=(
  "database-url=$DATABASE_URL"
  "bundle-encryption-key=$BUNDLE_ENCRYPTION_KEY"
  "inbound-key-tamm=$INBOUND_KEY_TAMM"
  "inbound-key-phc=$INBOUND_KEY_PHC"
  "inbound-key-school=$INBOUND_KEY_SCHOOL"
)
if [ "$AI" = on ]; then
  API_ENV+=("SUMMARY_LLM_ENABLED=true" "SUMMARY_PROVIDER=anthropic" "ANTHROPIC_API_KEY=secretref:anthropic-api-key")
  API_SECRETS+=("anthropic-api-key=$ANTHROPIC_API_KEY")
else
  API_ENV+=("SUMMARY_LLM_ENABLED=false")
fi
[ "$EDGE" = cloudflare ] && API_ENV+=("CLIENT_IP_HEADER=cf-connecting-ip")

# deploy_app <name> <repository> <port> <min> <max> <cpu> <memory> [--secrets ... --env-vars ...]: create the app, or update it.
deploy_app() {
  local name=$1 repo=$2 port=$3 min=$4 max=$5 cpu=$6 memory=$7
  shift 7
  local image=$ACR_SERVER/$repo:$TAG
  if exists az containerapp show -n "$name" -g "$AZURE_RESOURCE_GROUP"; then
    say "$name exists; updating it to $image"
    if [ "${1:-}" = --secrets ]; then
      # Everything up to --env-vars is the secret list.
      local secrets=() envs=() mode=secrets arg
      shift
      for arg in "$@"; do
        if [ "$arg" = --env-vars ]; then mode='env'; continue; fi
        if [ "$mode" = secrets ]; then secrets+=("$arg"); else envs+=("$arg"); fi
      done
      run az containerapp secret set -n "$name" -g "$AZURE_RESOURCE_GROUP" -o none --secrets "${secrets[@]}"
      run az containerapp update -n "$name" -g "$AZURE_RESOURCE_GROUP" -o none --image "$image" --min-replicas "$min" --max-replicas "$max" --cpu "$cpu" --memory "$memory" --set-env-vars "${envs[@]}"
    else
      run az containerapp update -n "$name" -g "$AZURE_RESOURCE_GROUP" -o none --image "$image" --min-replicas "$min" --max-replicas "$max" --cpu "$cpu" --memory "$memory"
    fi
  else
    # The role assignment can take a minute to spread, and until it has the registry refuses the pull: so the create is retried.
    retry 8 20 az containerapp create -n "$name" -g "$AZURE_RESOURCE_GROUP" -o none --environment "$ENV_NAME" --image "$image" \
      --user-assigned "$IDENTITY_ID" --registry-server "$ACR_SERVER" --registry-identity "$IDENTITY_ID" \
      --ingress external --target-port "$port" --revisions-mode single --min-replicas "$min" --max-replicas "$max" --cpu "$cpu" --memory "$memory" \
      "$@"
  fi
}

deploy_app "$APP_API" mawsool-api 4000 1 1 0.5 1.0Gi --secrets "${API_SECRETS[@]}" --env-vars "${API_ENV[@]}"
deploy_app "$APP_PERSON" mawsool-person 80 0 1 0.25 0.5Gi
deploy_app "$APP_CLINIC" mawsool-clinician 3000 0 1 0.5 1.0Gi
deploy_app "$APP_OPS" mawsool-ops 3000 0 1 0.5 1.0Gi

# The address the images were built with has to be the address the app really got.
if [ "$DRY_RUN" = 0 ]; then
  actual=$(az containerapp show -n "$APP_API" -g "$AZURE_RESOURCE_GROUP" --query properties.configuration.ingress.fqdn -o tsv)
  if [ "$EDGE" = azure ] && [ "https://$actual" != "$URL_API" ]; then
    die "the API's address is https://$actual, but the images were built for $URL_API; rebuild is needed (delete the tags and rerun)"
  fi
  say "API address: https://$actual"
fi

# --- 9. custom domains and the Cloudflare lock (EDGE=cloudflare only) -------------------------------------------------------------
if [ "$EDGE" = cloudflare ]; then
  step "9. Custom domains and the ingress lock (stage 3B)"
  export MAWSOOL_ENV_VERIFICATION_ID=$VERIFICATION_ID
  export MAWSOOL_HOST_API=$HOST_API MAWSOOL_HOST_PERSON=$HOST_PERSON MAWSOOL_HOST_CLINIC=$HOST_CLINIC MAWSOOL_HOST_OPS=$HOST_OPS
  for pair in "API:$APP_API" "PERSON:$APP_PERSON" "CLINIC:$APP_CLINIC" "OPS:$APP_OPS"; do
    fqdn=$(read_value "<$pair-fqdn>" az containerapp show -n "${pair#*:}" -g "$AZURE_RESOURCE_GROUP" --query properties.configuration.ingress.fqdn -o tsv)
    export "MAWSOOL_FQDN_${pair%%:*}=$fqdn"
  done
  # Part 1 writes the four asuid TXT records and the four CNAMEs as DNS-only, so Azure's lookup finds them when a name is bound.
  run "$HERE/cloudflare.sh" part1
  cert_password='<certificate-password>'
  if [ "$DRY_RUN" = 0 ]; then
    cert_password=$(openssl rand -hex 16)
    remember_secret "$cert_password"
    openssl pkcs12 -export -inkey "$ORIGIN_KEY_FILE" -in "$ORIGIN_CERT_FILE" -out "$WORK/origin.pfx" -passout "pass:$cert_password"
  fi
  run az containerapp env certificate upload -n "$ENV_NAME" -g "$AZURE_RESOURCE_GROUP" --certificate-file "$WORK/origin.pfx" --certificate-password "$cert_password" --certificate-name "$CERT_NAME" -o none
  for pair in "$APP_API:$HOST_API" "$APP_PERSON:$HOST_PERSON" "$APP_CLINIC:$HOST_CLINIC" "$APP_OPS:$HOST_OPS"; do
    app=${pair%%:*}
    host=${pair#*:}
    retry 6 30 az containerapp hostname add -n "$app" -g "$AZURE_RESOURCE_GROUP" --hostname "$host" -o none
    run az containerapp hostname bind -n "$app" -g "$AZURE_RESOURCE_GROUP" --hostname "$host" --environment "$ENV_NAME" --certificate "$CERT_NAME" -o none
  done
  # Part 2 turns the four CNAMEs to proxied and applies the zone rules.
  run "$HERE/cloudflare.sh" part2
  # Only now is the ingress locked, so the apps never refuse Cloudflare while it is still being set up.
  ranges=$(read_value '10.0.0.0/8' sh -c 'curl -fsS -m 20 https://www.cloudflare.com/ips-v4 && echo && curl -fsS -m 20 https://www.cloudflare.com/ips-v6')
  printf '%s\n' "$ranges" | grep -Eq '^[0-9a-fA-F:.]+/[0-9]+$' || die "could not read Cloudflare's address ranges"
  for app in "$APP_API" "$APP_PERSON" "$APP_CLINIC" "$APP_OPS"; do
    n=0
    for cidr in $ranges; do
      n=$((n + 1))
      run az containerapp ingress access-restriction set -n "$app" -g "$AZURE_RESOURCE_GROUP" --rule-name "cloudflare-$n" --ip-address "$cidr" --action Allow -o none
    done
  done
fi

# --- 10. first seed --------------------------------------------------------------------------------------------------------------
step "10. First seed"
# The API takes a moment to start; wait for it before judging anything.
wait_for() { # wait_for <url> <tries>: until the URL answers 200
  local n=0
  until [ "$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$1" || true)" = 200 ]; do
    n=$((n + 1))
    [ "$n" -ge "$2" ] && return 1
    sleep 10
  done
}
if [ "$DRY_RUN" = 1 ]; then
  say "+ wait for $URL_API/health"
  say "+ seed only if the API says demoMode true, its /services is [], and the demo admin's sign-in gives Fastify's own 404, twice, 5 s apart"
  say "+ then: az containerapp exec -n $APP_API -g $AZURE_RESOURCE_GROUP --command 'pnpm --filter @mawsool/api db:seed'"
  say "+ then sign in as the guest admin and POST /demo/reset"
else
  # With EDGE=cloudflare the public address is not reachable until DNS is proxied; the default address is always there.
  CHECK_API=https://$(az containerapp show -n "$APP_API" -g "$AZURE_RESOURCE_GROUP" --query properties.configuration.ingress.fqdn -o tsv)
  [ "$EDGE" = cloudflare ] && say "(checks use the default address $CHECK_API; with the ingress locked to Cloudflare they may be refused, which is expected)"
  wait_for "$CHECK_API/health" 30 || die "the API did not answer /health at $CHECK_API; read its log (see README)"
  state=$(seed_state "$CHECK_API")
  case "$state" in
    seeded) say "the demo admin can already sign in: the database is seeded, leaving it as it is" ;;
    empty)
      # A 404 can be a passing one (a revision swap). Seed only when the same answer comes again.
      sleep 5
      [ "$(seed_state "$CHECK_API")" = empty ] || die "the first look said the database is empty and the second did not; not seeding. Run the script again."
      say "the database is empty (confirmed twice): seeding it once"
      az containerapp exec -n "$APP_API" -g "$AZURE_RESOURCE_GROUP" --command "pnpm --filter @mawsool/api db:seed" ||
        die "the seed could not run non-interactively; run it by hand: az containerapp exec -n $APP_API -g $AZURE_RESOURCE_GROUP --command 'pnpm --filter @mawsool/api db:seed'   then run this script again"
      token=$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"email":"admin@demo.mawsool.test"}' "$CHECK_API/demo/guest-session" | sed -n 's/.*"sessionToken":"\([^"]*\)".*/\1/p')
      [ -n "$token" ] || die "the demo admin could not sign in after the seed"
      remember_secret "$token"
      status=$(curl -s -m 120 -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $token" "$CHECK_API/demo/reset")
      [ "$status" = 200 ] || die "the first reset answered $status, not 200"
      say "seeded and reset: the 90 days end today and Noura's invite exists"
      ;;
    *) die "cannot tell whether the database is seeded (the API did not give a clear answer at $CHECK_API); not seeding. Look at its log and run the script again." ;;
  esac
fi

# --- 11. smoke ---------------------------------------------------------------------------------------------------------------------
step "11. Smoke check"
if [ "$DRY_RUN" = 1 ]; then
  say "+ GET $URL_API/clock (demoMode true), $URL_PERSON/en/, $URL_CLINIC/en/sign-in/, $URL_OPS/en/sign-in/ (each 200)"
else
  smoke_api=$CHECK_API
  say "GET $smoke_api/clock: $(curl -s -m 30 "$smoke_api/clock")"
  fqdn_of() { az containerapp show -n "$1" -g "$AZURE_RESOURCE_GROUP" --query properties.configuration.ingress.fqdn -o tsv; }
  for pair in "person:$APP_PERSON:/en/" "clinic:$APP_CLINIC:/en/sign-in/" "ops:$APP_OPS:/en/sign-in/"; do
    label=${pair%%:*}
    rest=${pair#*:}
    if wait_for "https://$(fqdn_of "${rest%%:*}")${rest#*:}" 12; then say "$label app answers"; else say "$label app did not answer 200 in time"; fi
  done
fi

step "Done"
say "person    $URL_PERSON"
say "clinic    $URL_CLINIC"
say "ops       $URL_OPS"
say "api       $URL_API"
