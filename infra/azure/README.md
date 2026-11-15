# Hosting the demo on Azure

Runbook for `deploy.sh`. It puts the working prototype at public HTTPS addresses so the hackathon judges can open it with
nothing installed: a Container Apps environment with four apps (the person app, the clinic app, the ops app and the API), a
PostgreSQL Flexible Server and a container registry, in one resource group on an Azure free trial.

| File | What it is |
| --- | --- |
| `deploy.sh` | The deploy. `--init`, `--check`, `--dry-run`, or no flag to deploy. Safe to run again. |
| `azure.env.example` | The names `deploy.sh` reads. The real file is `<workspace root>/.local/azure.env` (git-ignored). |
| `cloudflare.sh` | Stage 3B: the Cloudflare DNS records, the proxy and one zone rule for the four hostnames (`part1`, `part2`). |
| `acr-task.yaml` | One Azure Container Registry run that builds and pushes the four images (linux/amd64). |
| `compose.prod-like.yml` | The same four images on this machine, for a check before anything goes to Azure. |
| `../../Dockerfile`, `../Caddyfile.person` | The image targets: `api`, `person`, `clinician`, `ops`. |

`cloudflare.sh` (DNS, the proxy and one zone rule for the four hostnames) is stage 3B; `deploy.sh` calls it as `part1` and `part2`. `cloudflare.sh part1|part2 --dry-run` prints what it would write and calls nothing.

## The two stages

- **Stage 3A (now): Azure only, `EDGE=azure`, `AI=off`.** The apps keep their `azurecontainerapps.io` addresses and their
  ingress is open. `RATE_LIMIT` is on with `CLIENT_IP_HEADER` unset, so each route's limit is one cap shared by every visitor.
  The AI is off, so every draft is the template and nothing is spent.
- **Stage 3B (later): Cloudflare and the Anthropic key, `EDGE=cloudflare`, `AI=on`.** The four hostnames under
  `thevergara.dev`, with Container Apps managed certificates (free, no certificate file), `CLIENT_IP_HEADER=cf-connecting-ip`, then
  the ingress locked to Cloudflare's address ranges. See "Moving to stage 3B".

## What the deploy sets up

Subscription "Azure subscription 1", region `uaenorth` (the database may sit in `PG_LOCATION`, see Step 11b), resource group `mawsool-demo-rg`.

| Resource | Name | Notes |
| --- | --- | --- |
| Container Registry | `mawsool` + 6 characters of a hash of the subscription id | Basic. Pulls use a managed identity (`mawsool-pull`, role AcrPull); the admin user is off. |
| Container Apps environment | `mawsool-env` | Consumption plan; Azure creates its Log Analytics workspace. |
| PostgreSQL Flexible Server | `mawsool-pg-` + the same 6 characters | Burstable B1ms, PostgreSQL 17, in `PG_LOCATION` (default `AZURE_LOCATION`), 32 GB, 7-day backups, database `mawsool`, firewall open to Azure services only. |
| Apps | `mawsool-api`, `mawsool-person`, `mawsool-clinic`, `mawsool-ops` | Single revision mode. The API runs at exactly 1 replica (its clock queue, rate limiter and AI budget live in one process); the web apps scale 0 to 1. |

API settings: `DEMO_MODE=true`, `RATE_LIMIT=true`, `DEMO_RESET_COOLDOWN_MS=300000`, `DEMO_RESET_CRON=0 23 * * *` (03:00 in the
UAE), `SUMMARY_DAILY_LIMIT=100`, `SUMMARY_LLM_ENABLED=false` (true with `AI=on`, with `SUMMARY_PROVIDER=anthropic`), and
`CORS_ORIGINS`, `PERSON_APP_URL`, `CLINICIAN_APP_URL`, `OPS_APP_URL` set to the three web apps' addresses. The database URL,
the bundle encryption key and the three `INBOUND_KEY_*` (and, with `AI=on`, the Anthropic key) are Container Apps secrets.

The images are built from the **committed** files of the current git commit (`git archive HEAD`), never from the working tree,
and tagged `<commit>-<hash of the API address>`: the API address is built into the images, so the same commit built for a
different address is a different image. A tag that is already in the registry is not rebuilt.

## First deploy (stage 3A)

Needs: `az login` done, `az` on the subscription named in `azure.env`, `git`, `curl`, `openssl`. No Docker is needed: the build
runs in the registry.

```
infra/azure/deploy.sh --init       # creates .local/azure.env if it is missing and generates the secrets; prints no value
infra/azure/deploy.sh --check      # read-only: login, subscription, resource providers, region, names
infra/azure/deploy.sh --dry-run    # prints every step and command, secrets shown as ***; no call to Azure at all
infra/azure/deploy.sh              # asks for "yes", then deploys (--yes skips the question)
infra/azure/deploy.sh --probe=https://<api address>   # read-only: seeded, empty or unknown (needs no Azure and no settings)
```

The steps, in order: register the resource providers that are not registered (this subscription has none of the five
registered, and registering is a change to the subscription), resource group, registry, pull identity, environment, Postgres,
images (one ACR run, or Docker builds here with `IMAGE_BUILD=local` where ACR Tasks is refused), the four apps, the first seed, a smoke check. It stops at the first failure; run it again to continue.
Creating the Postgres server takes several minutes.

**First seed.** The database starts empty and the guest sign-in answers 404 until it is seeded. The script runs
`az containerapp exec ... pnpm --filter @mawsool/api db:seed` once, then signs in as the guest admin and calls reset, so the 90
days end today and Noura's invite exists. It seeds only when the API says it is a demo, its `/services` is `[]` and the guest
sign-in gives Fastify's own not-found body, and the same answer comes twice, 5 seconds apart. A 404 from Azure's front end during
a revision swap has another body, and anything unclear stops the script without seeding. A redeploy never wipes data. If
`exec` cannot run without a terminal, the script stops and prints the command to run by hand, then run the script again.

Later deploys keep the data; the nightly reset (`DEMO_RESET_CRON`) puts the demo back to its scripted state each night.

## Redeploying

Change the code, commit, and run `deploy.sh` again: it builds the new commit, updates the four apps to it and leaves the data.
Changes to `azure.env` (a secret, `AI`) are applied to the API at the same time. Updating the API starts a new revision, so
for a minute two API processes run and the in-memory rate limits and AI budget are split; that is accepted.

`AI=on` needs `ANTHROPIC_API_KEY` in `azure.env` and is stage 3B work; with `AI=off` the key is not read or required.

## Step 11b: platform check

Azure part, read-only, run 2026-11-15 with `az` on "Azure subscription 1":
- Container Apps managed environments, Container Registry and PostgreSQL Flexible Server are all offered in UAE North.
- Flexible Server in `uaenorth` lists the Burstable SKU `Standard_B2s` and PostgreSQL versions 11 to 18 (`az postgres
  flexible-server list-skus -l uaenorth`), with the feature `OfferRestricted` disabled.
  The list also shows `Standard_B1ms` and `Standard_B2s`, but creating either failed with `SkuNotAvailable` in `uaenorth` on this
  subscription (2026-11-15 and 2026-11-16). The list is not a quota or an entitlement. The database therefore takes its own
  region: set `PG_LOCATION` (default `AZURE_LOCATION`) in `azure.env`; the apps and the rest stay in `AZURE_LOCATION`. The SKU is `Standard_B1ms`.
  Run 2026-11-16: `qatarcentral` and `westeurope` refused ("The location is restricted"), `northeurope` and `swedencentral` gave `SkuNotAvailable`,
  `uksouth` created `Standard_B1ms`. The name `mawsool-pg-c91953` stayed reserved to `uaenorth` by the earlier refusals, so `PG_SERVER_NAME`
  carries a suffix (`mawsool-pg-c91953d`). `az postgres flexible-server list-skus -l <region>` reports a restriction in its `reason` field.
- ACR Tasks (`az acr run`) is refused on this subscription (`TasksOperationsNotAllowed`), so the images are built with Docker
  and pushed (`IMAGE_BUILD=local`).
- The registry name `mawsoolc91953` was free (`az acr check-name`).
- Not established by these reads: that the free trial's quota lets the environment, the server and the registry actually be
  created (a list of capabilities is not a quota); the first deploy is that check. If the region refuses, pick the nearest one
  that offers all three, set `AZURE_LOCATION` and record it here.

Not yet run (stage 3B): the AI check (one draft with `SUMMARY_PROVIDER=anthropic` and the prepaid key, with its latency
against the phone's 10-second wait) and the Cloudflare checks (Universal SSL on a first-level name, the Configuration Rules
read call, turning off Web Analytics injection, Cloudflare's address ranges). Record the results here when they run.

**The trial's end date: not established.** The free trial ends 30 days from sign-up or when the $200 credit is used up,
whichever is first; after that the subscription is disabled unless it is moved to pay-as-you-go, and moving within 30 days
keeps the 12-month free services. The sign-up date is the account owner's to read in the Azure portal and write here.

## Moving to stage 3B

1. Run step 11b's AI and Cloudflare parts and record the results above. If the AI check fails, keep `AI=off`.
2. Put `ANTHROPIC_API_KEY` (a prepaid key, auto-reload off, a spend limit in the Anthropic Console) in `azure.env` when `AI=on`;
   set `EDGE=cloudflare`. `CF_API_TOKEN` and `CF_ACCOUNT_ID` are read from `azure.env`, else from `<workspace>/.claude/settings.local.json`
   (`env`); the token needs Zone DNS edit and Zone Config Rules edit (Web Analytics read is optional). `CF_ZONE_ID` is
   looked up by `CF_DOMAIN` when empty.
3. `deploy.sh` moves to Cloudflare in this order, so the running demo is never moved before its hostnames work. Each Cloudflare
   part prints its changes before it writes them:
   1. Apps that already run are left on their old images and settings; any that are missing are created. The images are built
      (a new tag, because the API hostname is part of it; `IMAGE_BUILD=local` where ACR Tasks is refused) but no running app moves.
   2. `cloudflare.sh part1`: `asuid.<host>` TXT records (the environment's verification ID) and the four CNAMEs, DNS-only. It stops
      (never deleting, never re-pointing) when another record type sits at one of the four names or a CNAME already points
      elsewhere. A snapshot of the zone's records and rules goes to `.local/tmp/cloudflare-before-<time>.json` before the first write.
   3. `az containerapp hostname add` (skipped when the hostname is already listed) and `hostname bind --validation-method CNAME`
      (skipped when already bound): Azure issues a managed certificate and `deploy.sh` waits for it (10 minutes at most).
   4. `cloudflare.sh part2`: first one Configuration Rule (ref `mawsool_demo_hostnames`) for exactly the four hostnames (SSL strict,
      Rocket Loader off, email obfuscation off), merged with the rules already in the zone's entry point; only an answer of
      "no such entry point" counts as no rules, and any other failed read stops before a write. Then the four CNAMEs are proxied.
      Web Analytics is read-only: it reports whether automatic injection is on for the zone and changes nothing (its per-host API
      has not been run). If it is on, the exclusion is made by hand in the dashboard; the smoke check then looks for the beacon in a
      browser-like page request (a plain `curl` is not injected).
   5. Each of the four `https://<host>/` (the API on `/health`, served by the old image) must answer through Cloudflare. If one
      does not, the run stops with the apps still on the default addresses.
   6. Only now the apps roll to the new images and settings: `NEXT_PUBLIC_API_URL=https://mawsool-api.thevergara.dev`, the four URL
      settings (`CORS_ORIGINS` keeps the default addresses as well as the hostnames), `CLIENT_IP_HEADER=cf-connecting-ip`. The run
      waits for each newest revision to be the ready one and for the hostnames to answer 200.
   7. The ingress lock: every Cloudflare range (fetched at run time from `cloudflare.com/ips-v4` and `ips-v6`), as a rule named
      `cf-<range>`, applied to each app in ONE update (an `az rest` PATCH of `ipSecurityRestrictions`, api-version 2025-07-01; it replaces the app's
      restrictions as a whole). If Container Apps refuses the IPv6 ranges, the IPv4 ranges go in alone, still as one update.
   8. The smoke check goes through Cloudflare: the three pages answer 200 and carry no Web Analytics beacon, each
      `azurecontainerapps.io` address answers exactly 403 (the API on `/health`), `/clock` answers on the API hostname, and the
      clinician page policy names it.

Managed certificates are issued while the CNAMEs are DNS-only. Whether they renew behind the proxy and the ingress lock is not
established; for a demo of weeks that does not matter, and a rerun of `deploy.sh` after a renewal failure would show it.

The `EDGE=cloudflare` path of `deploy.sh` and `cloudflare.sh` have been dry-run and run against a mock `curl` only. They have not
run against Azure or Cloudflare.

## Rolling back to 3A

In this order (the ingress is opened first, so nobody is refused while the apps move back):
1. Open the ingress of each of the four apps:
   `az rest --method patch --url "/subscriptions/<id>/resourceGroups/mawsool-demo-rg/providers/Microsoft.App/containerApps/<app>?api-version=2025-07-01" --body '{"properties":{"configuration":{"ingress":{"ipSecurityRestrictions":[]}}}}' --output none`
   (or `az containerapp ingress access-restriction remove -n <app> -g mawsool-demo-rg --rule-name <cf-...>` per rule, names from
   `access-restriction list`).
2. Set `EDGE=azure` in `azure.env` and run `deploy.sh`: the apps roll to images built for the default API address and the default URLs.
3. Remove the Cloudflare setting from the API: `az containerapp update -n mawsool-api -g mawsool-demo-rg --remove-env-vars CLIENT_IP_HEADER -o none`.

Leaving the hostnames bound and the DNS records in place is harmless: the default addresses keep working, and the hostnames
simply stop being used. Remove them as in "Restoring Cloudflare" when they are no longer wanted.

## Rotating a secret

Edit the value in `azure.env` and run `deploy.sh`. It updates the Container Apps secret and the API restarts on it.
- `BUNDLE_ENCRYPTION_KEY`: data already stored under the old key can no longer be read. Reset the demo afterwards (the guest
  admin's Reset); a reset reloads the seed.
- `INBOUND_KEY_*`: the front doors that sign with the old key are refused until they have the new one.
- `POSTGRES_ADMIN_PASSWORD`: `deploy.sh` does not change the password of a server that already exists. Change it on the server
  first (`az postgres flexible-server update -g mawsool-demo-rg -n <server> --admin-password <new> -o none`; without `-o none` az
  prints the new password back), then in `azure.env`,
  then run the script.
- The Anthropic key: replace `ANTHROPIC_API_KEY` and run the script; revoke the old one in the Anthropic Console.

## Reading the API log

```
az containerapp logs show -n mawsool-api -g mawsool-demo-rg --tail 100
az containerapp logs show -n mawsool-api -g mawsool-demo-rg --follow
```

The log holds the method and route of each request, and nothing else about it. A staff sign-in link, for the link flow,
is written there on purpose (`staff_sign_in` with its link); the guest buttons do not need one.

## Turning the AI off

Fast, without a redeploy: `az containerapp update -n mawsool-api -g mawsool-demo-rg --set-env-vars SUMMARY_LLM_ENABLED=false`.
To keep it off, set `AI=off` in `azure.env`. Drafts are then written from the template.

## If the API cannot reach Postgres (step 10)

The URL carries `sslmode=require`, which Flexible Server needs. If the API log shows a certificate or SSL error, `pg`,
the migrator or pg-boss is not accepting Azure's certificate chain: add a `DATABASE_SSL` option to `db/client.ts`,
`db/migrate.ts` and `jobs.ts` (nothing here works around it). This has not been tried against Azure yet.

## Restoring Cloudflare

Stage 3B. `cloudflare.sh` saves the zone's current DNS records and rules to `.local/tmp/cloudflare-before-<time>.json` before it writes
anything. To undo: delete the eight records it added (four `asuid.` TXT, four CNAMEs) and the rule `mawsool_demo_hostnames`; nothing
else in the zone is touched, so the snapshot is a reference, not something to re-import.

## Tearing everything down after judging

Both need the owner's go-ahead.
- Azure: `az group delete -n mawsool-demo-rg` removes the environment, the four apps, the registry, the identity and the
  database. The images and the data go with them.
- Cloudflare (stage 3B): remove the eight DNS records and the Configuration Rule `mawsool_demo_hostnames` .

## What was not tested

Everything in `deploy.sh` that changes Azure has not run: it is checked by `bash -n`, shellcheck, `--dry-run` for both stages,
the read-only `--check`, a run against a stand-in `az` that echoes every argument back (no secret reached the output), and
`--probe` against a mock API for the seed decision. Known unknowns for the first run: the free trial's quota for these resources, whether
`az containerapp exec` runs the seed without a terminal, whether the registry's build agent builds the Dockerfile (it uses no
BuildKit-only feature, but a classic builder was not tried), and the Postgres TLS question above.
