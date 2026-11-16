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

## Live state (2026-11-16)

Both stages have run. The demo is live in stage 3B, `EDGE=cloudflare`, `AI=on`:

| Part | State |
| --- | --- |
| Addresses | `https://mawsool.thevergara.dev` (person), `https://mawsool-clinic.thevergara.dev`, `https://mawsool-ops.thevergara.dev`, `https://mawsool-api.thevergara.dev`, each behind Cloudflare (proxied) with a free Container Apps managed certificate. The default `azurecontainerapps.io` addresses answer 403. |
| Apps | `uaenorth`. All four run at exactly 1 replica (idle-rate cost around the clock: not established). |
| Database | PostgreSQL Flexible Server `mawsool-pg-c91953d`, Standard_B1ms, in `uksouth` (`PG_LOCATION=uksouth`; the apps and the database are in different regions, and the latency between them was not measured). The API connects with `sslmode=require` and that works. |
| Images | Built with Docker here and pushed (`IMAGE_BUILD=local`): ACR Tasks is refused on this subscription. |
| Ingress lock | Cloudflare's IPv4 ranges only: Container Apps refused the IPv6 ranges (`IpRestrictionsAddressEnteredInvalid`). Cloudflare reaches the origin over IPv4. |
| Zone rule | One Configuration Rule, ref `mawsool_demo_hostnames`, for the four hostnames only: SSL strict, Rocket Loader off, email obfuscation off, `disable_rum` true (Web Analytics injection was on for the zone and put its script on the pages; the rule keeps it off these four hostnames and the zone setting is untouched). |
| DNS | Eight records: four `asuid.` TXT and four CNAMEs. The zone has no CAA records (read by the orchestrator on 2026-11-16), so Azure's certificate authority is not blocked. |
| AI | On since 2026-11-16 (`SUMMARY_LLM_ENABLED=true`, `SUMMARY_PROVIDER=anthropic`, the owner's prepaid Anthropic key as the Container Apps secret `anthropic-api-key`), capped at `SUMMARY_DAILY_LIMIT=100` drafts a UTC day. It was switched on in place (`az containerapp secret set` and `az containerapp update`), and `azure.env` holds `AI=on` and the key, so a redeploy keeps it on. |

## The two stages

- **Stage 3A: Azure only, `EDGE=azure`.** The apps keep their `azurecontainerapps.io` addresses and their ingress is open.
  `RATE_LIMIT` is on with `CLIENT_IP_HEADER` unset, so each route's limit is one cap shared by every visitor. It was the first
  deploy and is also the rollback target.
- **Stage 3B: Cloudflare, `EDGE=cloudflare` (live).** The four hostnames under `thevergara.dev`, with Container Apps managed
  certificates (free, no certificate file), `CLIENT_IP_HEADER=cf-connecting-ip`, then the ingress locked to Cloudflare's
  address ranges. See "How stage 3B runs". `AI=on` (the Anthropic key) is live: see "Live state".

## What the deploy sets up

Subscription "Azure subscription 1", region `uaenorth` (the database may sit in `PG_LOCATION`, see Step 11b), resource group `mawsool-demo-rg`.

| Resource | Name | Notes |
| --- | --- | --- |
| Container Registry | `mawsool` + 6 characters of a hash of the subscription id | Basic. Pulls use a managed identity (`mawsool-pull`, role AcrPull); the admin user is off. |
| Container Apps environment | `mawsool-env` | Consumption plan; Azure creates its Log Analytics workspace. |
| PostgreSQL Flexible Server | `mawsool-pg-` + the same 6 characters | Burstable B1ms, PostgreSQL 17, in `PG_LOCATION` (default `AZURE_LOCATION`), 32 GB, 7-day backups, database `mawsool`, firewall open to Azure services only. |
| Apps | `mawsool-api`, `mawsool-person`, `mawsool-clinic`, `mawsool-ops` | Single revision mode. The API runs at exactly 1 replica (its clock queue, rate limiter and AI budget live in one process); the web apps also run at exactly 1 replica, because a cold start from zero took 10 to 30 s and a judge's first page would wait (a running replica is billed at the idle rate). |

API settings: `DEMO_MODE=true`, `RATE_LIMIT=true`, `DEMO_RESET_COOLDOWN_MS=300000`, `DEMO_RESET_CRON=0 23 * * *` (03:00 in the
UAE), `SUMMARY_DAILY_LIMIT=100`, `SUMMARY_LLM_ENABLED=false` (true with `AI=on`, with `SUMMARY_PROVIDER=anthropic`), and
`CORS_ORIGINS`, `PERSON_APP_URL`, `CLINICIAN_APP_URL`, `OPS_APP_URL` set to the three web apps' addresses. The database URL,
the bundle encryption key and the three `INBOUND_KEY_*` (and, with `AI=on`, the Anthropic key) are Container Apps secrets.

The images are built from the **committed** files of the current git commit (`git archive HEAD`), never from the working tree,
and tagged `<commit>-<hash of the API address>`: the API address is built into the images, so the same commit built for a
different address is a different image. A tag that is already in the registry is not rebuilt.

## First deploy (stage 3A)

Needs: `az login` done, `az` on the subscription named in `azure.env`, `git`, `curl`, `openssl`. With `IMAGE_BUILD=acr` (the
default) the build runs in the registry and no Docker is needed; with `IMAGE_BUILD=local` (what this subscription needs) Docker
must be running (OrbStack here) and builds for linux/amd64. `EDGE=cloudflare` also needs `jq`.

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
a revision swap has another body, and anything unclear stops the script without seeding. A redeploy never wipes data.
`az containerapp exec` needs a terminal and the script has none, so on an empty database it stops and prints the command. The first
seed here was done by hand under a pseudo-terminal, then the script was run again and found the database seeded:

```
script -q /dev/null az containerapp exec -n mawsool-api -g mawsool-demo-rg --command 'pnpm --filter @mawsool/api db:seed' < /dev/null
```

It printed `seeded 2 facilities, 24 services, 470 persons, 500 tickets, 1517 events, 40 crisis events`. The script's own seed step
did not work without a terminal and was not changed.

Later deploys keep the data; the nightly reset (`DEMO_RESET_CRON`) puts the demo back to its scripted state each night.

## Redeploying

Change the code, commit, and run `deploy.sh` again: it builds the new commit, updates the four apps to it and leaves the data.
Changes to `azure.env` (a secret, `AI`) are applied to the API at the same time. Updating the API starts a new revision, so
for a minute two API processes run and the in-memory rate limits and AI budget are split; that is accepted.

`AI=on`, as now, needs `ANTHROPIC_API_KEY` in `azure.env` (a prepaid key: extra payment); with `AI=off` the key is not read or required.

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
- The first deploy was the quota check: the environment, the registry and the identity were created in `uaenorth`, the server only
  in `uksouth` (above), and the apps ran on the trial.

Cloudflare part, run 2026-11-16 with the project token on `thevergara.dev`:
- Universal SSL covers the first-level names (`mawsool.thevergara.dev` and the three `mawsool-*` names answer over HTTPS through
  Cloudflare, and the edge certificate verifies); the Configuration Rules phase can be read and written (the rule above was created);
  the zone has no CAA records.
- Web Analytics automatic injection was on for the zone and put `beacon.min.js` on the pages of the browser's requests (a plain
  `curl` is not injected), which the staff page policy blocked and the person app's connection to it was refused: console errors.
  `disable_rum` in the zone rule fixed it for the four hostnames.
- Cloudflare's IPv6 ranges are refused by Container Apps; the IPv4 ranges are accepted.

AI check, run 2026-11-16 after the AI was switched on (a Playwright script in Chromium against the person app and the API,
10 of 10 checks passed): `GET /summary/availability` answered `{"ai":"available"}`, the consent screen showed no "AI off" note, and
one draft with **Use AI to help write my note** ticked came back from the model (`source: ai`, labelled "Drafted by AI") in
3.3 seconds, under the phone's 10-second wait, 49 words, with nothing from the unticked note and no diagnosis, risk or advice term. One draft
is one sample, not a latency figure.

**The trial's end date: not established.** The free trial ends 30 days from sign-up or when the $200 credit is used up,
whichever is first; after that the subscription is disabled unless it is moved to pay-as-you-go, and moving within 30 days
keeps the 12-month free services. The sign-up date is the account owner's to read in the Azure portal and write here.

## How stage 3B runs

This is what `deploy.sh` does with `EDGE=cloudflare`, and what ran on 2026-11-16. To move a stage 3A deployment, set the
settings in step 1 and run it.

1. `AI=on` uses a prepaid Anthropic key (extra payment); `AI=off` turns it off. The AI check in step 11b ran once with it on.
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
      Rocket Loader off, email obfuscation off, `disable_rum` true, which keeps Cloudflare's Web Analytics beacon off them), merged
      with the rules already in the zone's entry point; an existing rule is compared with its keys sorted, so a rerun does not PUT it
      again. Only an answer of "no such entry point" counts as no rules, and any other failed read stops before a write. Then the four
      CNAMEs are proxied. The Web Analytics step is read-only: it reports whether automatic injection is on for the zone and changes
      nothing; the rule's `disable_rum` is what keeps the beacon off the four hostnames, and the smoke check looks for it in a
      browser-like page request (a plain `curl` is not injected).
   5. Each of the four `https://<host>/` (the API on `/health`, served by the old image) must answer through Cloudflare. If one
      does not, the run stops with the apps still on the default addresses.
   6. Only now the apps roll to the new images and settings: `NEXT_PUBLIC_API_URL=https://mawsool-api.thevergara.dev`, the four URL
      settings (`CORS_ORIGINS` keeps the default addresses as well as the hostnames), `CLIENT_IP_HEADER=cf-connecting-ip`. The run
      looks for each newest revision to be reported ready (advisory only) and waits for the four hostnames to answer 200, which is the gate.
   7. The ingress lock: every Cloudflare range (fetched at run time from `cloudflare.com/ips-v4` and `ips-v6`), as a rule named
      `cf-<range>`, applied to each app in ONE update (an `az rest` PATCH of `ipSecurityRestrictions`, api-version 2025-07-01; it replaces the app's
      restrictions as a whole). If Container Apps refuses the IPv6 ranges, the IPv4 ranges go in alone, still as one update.
   8. The smoke check goes through Cloudflare: the three pages answer 200 and carry no Web Analytics beacon, each
      `azurecontainerapps.io` address answers exactly 403 (the API on `/health`), `/clock` answers on the API hostname, and the
      clinician page policy names it.

Managed certificates are issued while the CNAMEs are DNS-only. Whether they renew behind the proxy and the ingress lock is not
established; for a demo of weeks that does not matter, and a rerun of `deploy.sh` after a renewal failure would show it.

The path ran once against Azure and Cloudflare (2026-11-16) and finished with every smoke check passing. Two of its steps needed a
result the dry runs could not give: the lock's IPv6 fallback (used, IPv4 only) and the Web Analytics report (injection was on,
fixed by `disable_rum`).

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
The public-demo consent screen says so: it reads `GET /summary/availability` (`available`, `off` or `daily_cap`) when it opens and shows
a note above the AI tick when the AI is off or the day's allowance (`SUMMARY_DAILY_LIMIT`) is spent, and again when a draft reply
carries `aiUnavailable`. A build without `NEXT_PUBLIC_PUBLIC_DEMO=true` makes no such request and shows no note.

## If the API cannot reach Postgres (step 10)

The URL carries `sslmode=require`, which Flexible Server needs, and it works live: the API, its migrations and the seed ran over it.
If the API log ever shows a certificate or SSL error, `pg`, the migrator or pg-boss is not accepting Azure's certificate chain:
add a `DATABASE_SSL` option to `db/client.ts`, `db/migrate.ts` and `jobs.ts` (nothing here works around it).

## Restoring Cloudflare

Stage 3B. `cloudflare.sh` saves the zone's current DNS records and rules to `.local/tmp/cloudflare-before-<time>.json` before it writes
anything. To undo: delete the eight records it added (four `asuid.` TXT, four CNAMEs) and the rule `mawsool_demo_hostnames`; nothing
else in the zone is touched, so the snapshot is a reference, not something to re-import.

## Tearing everything down after judging

Both need the owner's go-ahead.
- Azure: `az group delete -n mawsool-demo-rg` removes the environment, the four apps, the registry, the identity and the
  database. The images and the data go with them.
- Cloudflare (stage 3B): remove the eight DNS records and the Configuration Rule `mawsool_demo_hostnames`.

## What was not tested

Run live on 2026-11-16: every step of `deploy.sh` with `EDGE=cloudflare` (apart from the seed, done by hand), `cloudflare.sh part1`
and `part2`, the `--probe`, the smoke check, and one pass of a Playwright check in Chromium, in English, against the four
hostnames (16 checks passed). Not run, or not established:
- the AI beyond one draft (step 11b): its latency over many drafts, and the daily cap being reached;
- the nightly reset (`DEMO_RESET_CRON`) on the live app;
- a phone viewport on the live hostnames, and Arabic beyond the person app's home page loading right to left. That page, clinic B's queue, the programme lead's dashboard and the crisis-line console (all in English) were each opened once on 2026-11-16;
- rate-limit behaviour under load, and the API's cold start after a restart;
- renewal of the managed certificates behind the proxy and the lock;
- the rollback to stage 3A in "Rolling back to 3A": written, never run;
- the idle-rate cost of the four always-on replicas and the database against the trial credit, and the trial's end date;
- latency between the API in `uaenorth` and the database in `uksouth`;
- the seed step of `deploy.sh` without a terminal (it needs the command above).
