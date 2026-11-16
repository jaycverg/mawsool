# Running the demo

The demo script (the product spec's demo steps 1 to 12) needs the demo routes, and those exist only when the API is started with `DEMO_MODE` on. Without it the routes that move the demo clock and reset the data answer 404, and the admin panel in the ops app shows its controls as off. Everything else in the product works the same with it off.

1. Copy `.env.example` to `.env` and uncomment `DEMO_MODE=true`. Only `true` or `1` turns it on; unset, empty, `false` or `0` leaves it off, and any other value stops the API at start-up.
2. Start Docker (`orb start`), then `pnpm dev`. This starts Postgres, runs the migrations and starts the API on :4000, the person app on :3000, the clinician app on :3001 and the ops app on :3002 (all moved together by `PORT_OFFSET`).
3. Load the seed with `pnpm db:seed` first: a fresh database holds no staff, so nobody can sign in until it is seeded. It loads the data on the seed's fixed date. Then, signed in as admin (step 4), press **Reset the demo** in the ops app's demo controls: it reloads the same data anchored on today, so the last 90 days end where the demo begins, keeps you signed in, and makes the invite for Noura.
4. Staff sign-in links are logged, never sent. Ask for one at `<app>/en/sign-in/` for `admin@demo.mawsool.test` or `ops@demo.mawsool.test` (ops app), or `clinician.a@demo.mawsool.test` or `clinician.b@demo.mawsool.test` (clinician app), then copy the link from the API's log. A link works once, for 15 minutes.
5. In the ops app, signed in as admin, the demo controls move the demo clock by 7 days, 3 weeks or 6 weeks, reset everything, and open Noura's mock TAMM page in either language with her invite code. Rashid needs nothing loaded: he answers PHQ-9 item 9 with "several days" in the person app, which opens the crisis screen.

The demo clock's offset is kept in the database as you move it, so restarting the API (with `DEMO_MODE` still on) keeps the demo's date. **Reset the demo** empties it, and so does `pnpm db:seed`; starting the API with `DEMO_MODE` off ignores it and leaves it stored for the next demo start. Reset deletes the people and tickets the server holds, not what a phone keeps: a phone that held a ticket registers again the next time it contacts the server and drops that ticket, and its saved check-ins stay.

`pnpm gate:c` runs the whole script in Arabic and English with `DEMO_MODE` on, on ports 450 above the dev ports, and does not use your `.env`'s demo setting. The demo's spec is in [`demo-e2e-spec.md`](demo-e2e-spec.md).

## The hosted demo

A copy runs on sample data with `DEMO_MODE` on, on an Azure free trial behind Cloudflare
([runbook](../infra/azure/README.md)):

- **Person app:** <https://mawsool.thevergara.dev>. No sign-in.
- **Clinician app:** <https://mawsool-clinic.thevergara.dev>. **Continue as demo clinician, Clinic A (Sample PHC ·
  Khalifa City)** or **… Clinic B (Sample Clinic · Al Ain)**.
- **Ops app:** <https://mawsool-ops.thevergara.dev>. **Continue as demo programme lead** (the dashboard), **Continue as
  demo admin** (the demo clock, reset and Noura's invite) or **Continue as demo crisis-line operator** (the mock console).
- **API:** <https://mawsool-api.thevergara.dev>.

Where it differs from a local run:

- **Sign-in is one button.** The guest buttons appear only on a server with `DEMO_MODE` on; the logged sign-in links
  still work but land in the server's log, which visitors cannot read.
- **Everyone shares it.** The consent screen and the crisis hand-off panel say so: "Public demo: everything you enter
  here can be seen by anyone using this demo. Do not enter real details."
- **The crisis screen does not dial.** It shows 800-SAKINA, 999 and 998 as text, and **Call now** says "Demo: this
  button does not place a call. In a real emergency, dial the number yourself."
- **It resets itself every night** at 23:00 UTC (03:00 in the UAE), and **Reset the demo** can be pressed once every
  5 minutes.
- **The AI draft is on** (Anthropic's API), for at most 100 drafts a day (UTC) across all visitors. When it is off or
  used up, the consent screen says so and **Help me draft** gives the template.

## The referral-summary assistant at step 6

Step 6 shows the one place the product uses AI. After ticking what Noura shares, tick **Use AI to help write my note**,
then press **Help me draft**. The draft is marked "Drafted by AI. Check every word before you approve it."; she adds a
line and approves it. The demo video and the hosted demo show it this way. The model sees only the items ticked on the
consent screen, and the draft is capped at 120 words.

To show it from your own machine:

1. In `.env`, set `SUMMARY_LLM_ENABLED=true` and choose a provider: `SUMMARY_PROVIDER=anthropic` with
   `ANTHROPIC_API_KEY`, or `SUMMARY_PROVIDER=foundry` with `SUMMARY_FOUNDRY_API_KEY` and `SUMMARY_FOUNDRY_RESOURCE`
   (`.env.example` explains each). With the flag on and the provider or its key missing, the API refuses to start.
2. Restart `pnpm dev`.
3. Run `pnpm check:summary` before the demo (below).

**The pre-demo check.** `pnpm check:summary` checks the referral-summary assistant against a running API before the draft is shown. Start `pnpm dev` with `SUMMARY_LLM_ENABLED=true`, `SUMMARY_PROVIDER` and that provider's key in `.env`, then run it: it registers one throwaway device, asks for three drafts in English and three in Arabic from sample scores and a sample note the person did not tick, prints each draft with its time, and exits non-zero if any draft is not from the assistant, takes over 8 s (the phone gives up at 10 s), is over 114 words or cut off, repeats the unticked note, is in the wrong language or holds a listed word (a diagnosis, treatment, advice or risk term). With `SUMMARY_LLM_ENABLED` unset it fails with the "source is template" hint naming the settings to check. It never prints a setting's value, leaves six drafts and the device in the database (the sweep removes the drafts after 24 hours, **Reset the demo** (with `DEMO_MODE` on) or `pnpm db:seed` removes the device) and is not part of `pnpm verify`, because it needs a key. It cannot judge tone, so read the drafts. `E2E_SUMMARY_FROM_ENV=1` makes the end-to-end API harness (`pnpm --filter @mawsool/api serve:e2e`, started through `node scripts/with-env.mjs`) use the assistant from `.env` instead of keeping it off; it stops at start-up if `.env` does not turn the assistant on. Only the demo-video recording sets it, and no gate does.

**If no draft comes during a live demo:**

- **If the draft takes longer than 10 seconds,** the phone says "The draft could not be made. You can write the summary
  yourself." and shows no summary.
- **If the provider fails sooner,** the template appears.
- **Either way,** untick **Use AI to help write my note**, press **Help me draft** for the template and carry on: the
  model is unavailable, so she writes it herself. Keep the video's step 6 ready to show the AI draft.

`pnpm gate:c` runs with the assistant off and checks the template path: CI has no key, and the model writes different
text each run.

No automated check calls a real provider: the browser tests stand in for one with a stubbed reply (`answerAiDrafts` in
`apps/person/e2e/phase3-acceptance.spec.ts`), and `packages/summary` is tested with a stub provider. Before the assistant
is used outside a demo, see [Limitations](limitations.md), item 7.

## Labels

Every directory entry, insurance figure, Malaffi export, TAMM page, message and crisis console in the demo is sample data and is labelled as such on screen.
