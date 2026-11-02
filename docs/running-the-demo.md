# Running the demo

The demo script (the product spec's demo steps 1 to 12) needs the demo routes, and those exist only when the API is started with `DEMO_MODE` on. Without it the routes that move the demo clock and reset the data answer 404, and the admin panel in the ops app shows its controls as off. Everything else in the product works the same with it off.

1. Copy `.env.example` to `.env` and uncomment `DEMO_MODE=true`. Only `true` or `1` turns it on; unset, empty, `false` or `0` leaves it off, and any other value stops the API at start-up.
2. Start Docker (`orb start`), then `pnpm dev`. This starts Postgres, runs the migrations and starts the API on :4000, the person app on :3000, the clinician app on :3001 and the ops app on :3002 (all moved together by `PORT_OFFSET`).
3. Load the seed with `pnpm db:seed` first: a fresh database holds no staff, so nobody can sign in until it is seeded. It loads the data on the seed's fixed date. Then, signed in as admin (step 4), press **Reset the demo** in the ops app's demo controls: it reloads the same data anchored on today, so the last 90 days end where the demo begins, keeps you signed in, and makes the invite for Noura.
4. Staff sign-in links are logged, never sent. Ask for one at `<app>/en/sign-in/` for `admin@demo.mawsool.test` or `ops@demo.mawsool.test` (ops app), or `clinician.a@demo.mawsool.test` or `clinician.b@demo.mawsool.test` (clinician app), then copy the link from the API's log. A link works once, for 15 minutes.
5. In the ops app, signed in as admin, the demo controls move the demo clock by 7 days, 3 weeks or 6 weeks, reset everything, and open Noura's mock TAMM page in either language with her invite code. Rashid needs nothing loaded: he answers PHQ-9 item 9 with "several days" in the person app, which opens the crisis screen.

`pnpm gate:c` runs the whole script in Arabic and English with `DEMO_MODE` on, on ports 450 above the dev ports, and does not use your `.env`'s demo setting. The demo's spec is in [`demo-e2e-spec.md`](demo-e2e-spec.md).

Every directory entry, insurance figure, Malaffi export, TAMM page, message and crisis console in the demo is sample data and is labelled as such on screen.
