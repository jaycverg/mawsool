# Symptom change among re-measured tickets

`GET /metrics/outcomes` (access `ops`), served for the last 90 days only, code in `apps/api/src/metrics/outcomes.ts`, tests in `apps/api/test/metrics-outcomes.test.ts`, tile on the ops dashboard under "Symptom change after re-measure". The definitions the info panel shows are in `docs/metric-definitions.md`.

## One period, like equity

The route is served for the last 90 days (`EQUITY_PERIOD`) and no other. A request with any other `period` (`all`, `30d`, or a value the period schema does not allow) is a 400 with no figures; leaving `period` out answers the last 90 days. The same figure in two periods subtracts into a small group's results (all time less the last 90 days is the tickets from before the window, which can be a handful of named people), so there is no second period to subtract. The dashboard's period filter does not reach the tile, which says so in both languages in its note and its info panel, as the equity section and the Loop closed tile do.

The window slides with the care clock, so two responses taken on different days (or either side of a demo clock step) can still subtract. That is accepted, as it is for equity.

## What it counts

A ticket is **re-measured** when its events show it reached `remeasured` (the repeat check at six weeks). For each of PHQ-9 and GAD-7:

- **Included**: the ticket's person has the **anonymous statistics choice** on (below), the ticket's `ticket` and `scores` consents are both live, its bundle is not deleted, and the bundle's shared totals hold a referral total and a repeat total of that instrument. The repeat total is the newest one taken at or after the moment the check opened (six weeks after the event that made the ticket `seen`, `remeasureAvailableAt`); the referral total is the newest one taken before it. The API refuses a repeat total taken before that moment, so the split is exact.
- **Excluded**: any other re-measured ticket (the person did not opt in, no `scores` consent, consent stopped, share ended, bundle emptied, only one of the two totals, or a bundle that cannot be read). It is counted as excluded, per instrument, in one figure: there is no separate figure for the people who did not opt in. The bundle of a person who did not opt in is not opened.
- **Change** = repeat total minus referral total, so a fall means fewer symptoms. The mean is over the included tickets.
- **Reliable improvement** is a fall of at least the threshold, **reliable deterioration** a rise of at least it (`reliableChange` in `packages/rules`); the threshold value itself counts.

The window is the funnel's: a ticket belongs to the period of the root of its journey (the ticket it was rerouted from, if any).

## The anonymous statistics choice

Sharing totals with a clinic does not by itself let them count on the dashboard. A separate choice of the person does: `persons.outcome_stats_opt_in`, a boolean, **off by default**, modelled on the equity opt-in and kept per person (it applies to all of the person's tickets).

- **Where it is offered**: on the repeat check's totals screen, in its own box beneath "Send these two totals to my clinic", unticked; the box is disabled and shows unticked while the send box is unticked, because a total counts only if its copy is on the server. That pairing is the screen's only: the API accepts the choice with no totals (`statisticsOptIn` on a request with empty `scores`, or `PUT /me/outcome-statistics` alone) and counts a ticket only when both totals are on the server. Its value travels with the re-measure request (`statisticsOptIn`) and is stored in the same transaction as the move to `remeasured`, so a refused or lost request changes nothing; a request without it leaves the choice as it was. In Settings the choice appears once it is on, with one button to turn it off (`PUT /me/outcome-statistics`).
- **Its scope**: it is the person's, not the ticket's. Its label says it covers every total the person sends their clinics, on all their referrals and not only this one, until they turn it off.
- **The phone's note**: the phone keeps a note that the choice may be on at the server, so Settings can always turn it off. It is written BEFORE a send that carries `true` (a note that cannot be written stops the send, and the person is told), kept whatever follows, a lost or unreadable reply or even a refusal (409), because another tab's send may have turned the choice on at the server. A send that carries `false` clears the note only on a confirmed reply.
- **What it says**: in Arabic and English, that the totals count only in anonymous group figures of 10 or more people, and that a clinic never sees this choice.
- **When it is read**: when the figures are made, not copied onto a ticket or a bundle. Turning it off takes the person's tickets out of the next response.
- **Who never sees it**: no clinic-facing read carries it. The queue, the ticket, the bundle and the FHIR export are the same before and after the person turns it on (`consent.test.ts`), no clinic-facing schema has a field for it (`packages/types/test/types.test.ts`), and the clinician app names it nowhere (`apps/clinician/test/no-statistics-choice.test.ts`).
- **Erase**: "Delete everything" sets it back to off on the server and removes the phone's note of it. `apps/api/test/erase-reach.test.ts` reviews every column of `persons`, this one included.

## The thresholds and their source

`RELIABLE_CHANGE` in `packages/rules/src/config.ts`: **PHQ-9 6 points, GAD-7 4 points**.

Source (read in this run, not recalled): *The Improving Access to Psychological Therapies Manual: Appendices and helpful resources* (NCCMH, version 2), Table 1 "Clinical cut-offs and reliable change index": PHQ-9 caseness >= 10, reliable change >= 6; GAD-7 caseness >= 8, reliable change >= 4. Published at https://www.rcpsych.ac.uk/docs/default-source/improving-care/nccmh/iapt/nccmh-iapt-manual-appendices-helpful-resources-v2.pdf (the programme is now called NHS Talking Therapies).

The manual defines reliable improvement across both measures together (a reduction on either with no reliable increase on the other) and over everyone who completed a course of treatment. This dashboard reports each instrument on its own, over the re-measured tickets whose person shared both totals of it and opted in, which is a simpler and not an identical measure.

## What it reads, and what it never returns

The aggregate decrypts the shared bundle's `scores` on the server, only for tickets whose consents are live and whose person has opted in, and returns only counts, shares and a mean. No per-ticket figure, id or total leaves it. It is not a staff read of a bundle, so it writes no `bundle_reads` row. Stopping the scores, withdrawing, turning the choice off, or "Delete everything" removes a ticket from the included figures at once, because the consents, the bundle and the choice are read live.

## How small numbers are kept out

The cells (re-measured, and per instrument included, excluded, improved, deteriorated, unchanged) are one `ProtectedTable` with two relations per instrument: re-measured = included + excluded, and included = improved + deteriorated + unchanged. `hiddenCells` / `pinnedCells` hide cells until no small number can be worked out from what is published; a share is also shown only when its part, its whole and what is left over each reach ten; the mean is shown only while the included count is.

The two instruments' included counts are tied, as equity ties its "no bucket given" groups. They count different, overlapping sets of the same re-measured tickets, so two published included counts that differ by 1 to 9 subtract into a small group (25 and 22 leaves three people with a PHQ-9 pair only). When the difference is from 1 to 9, both included cells are hidden, and with them (by the relations) both excluded cells, the means and the shares. A difference of ten or more, or none, publishes nothing small and leaves them independent. The re-measured count itself is never hidden by the tie or by the relations (the funnel publishes the same count, and hiding it would only follow from an instrument whose excluded count is nothing): it is hidden only when the funnel hides it, and with it shown no non-empty hidden cell becomes exactly derivable (`pinnedCells`, checked in the tests).

**What it is tied to in the funnel.** The figures stand on the same people as the funnel's last stage, and now that their window is fixed, the tie is to that stage for the same 90 days (the funnel with no source or tier filter, `GET /metrics/funnel?period=90d`): the whole response is hidden whenever the funnel hides it (`remeasuredHiddenInFunnel`, computed over the same window start, `periodStart(EQUITY_PERIOD, now)`), so nothing here can be combined with the funnel to recover a number it hid. The re-measured count here is the same number as the funnel's 90-day stage, so the funnel's other periods subtract from it no further than they already do from each other.

Not covered, by decision: the funnel counts journeys while this counts tickets, which differ only where one journey holds two re-measured tickets (not reachable today); and the sliding window, above.

## In the demo

The deterministic seed gives 35 seen tickets a repeat check: parentless tickets the seed left `seen`, issued within the last 62 days and seen at least 45 days before the reset, so six weeks have passed and they are still inside "the last 90 days" up to 28 days and 23 hours into the demo (the dashboard step). Each gains `remeasured` and `closed` events, consent rows (`ticket` and `scores`), a stored bundle holding the referral and repeat totals of both instruments, and an opted-in person (`apps/api/src/seed/outcome-shares.ts`, drawn from a stream of its own so nothing else in the seed is drawn differently; the 35 tickets read `closed` instead of `seen`). The 47 older re-measured tickets share nothing.

Straight after a reset the tile shows 82 re-measured, 35 counted and 47 excluded for each instrument, the mean change (-3.3 and -1.8) and the share who improved (42.9% and 37.1%); the share who deteriorated reads "Suppressed" because only four people are behind it. At +7 days it reads 60 re-measured, 35 counted, 25 excluded. At +28 days and +28 days 23 hours the older 47 have left the window: 35 re-measured, all counted, the excluded count Suppressed (none, and zero is under ten), the same means and shares. The totals are sample data. The funnel's re-measured stage reads the same 82, 60 and 35 for the same windows, and the share that carries on from seen to re-measured is 24% rather than 14% at the reset.

Source: the seed's counts are asserted in `apps/api/test/seed.test.ts` and `apps/api/test/metrics.test.ts` (at the reset, +28 days and +28 days 23 hours); the tile on the default view and at step 11 in `apps/person/e2e/gate-c.spec.ts`.
