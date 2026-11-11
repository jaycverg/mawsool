# Symptom change among re-measured tickets

`GET /metrics/outcomes?period=all|90d|30d` (access `ops`), code in `apps/api/src/metrics/outcomes.ts`, tests in `apps/api/test/metrics-outcomes.test.ts`, tile on the ops dashboard under "Symptom change after re-measure". The definitions the info panel shows are in `docs/metric-definitions.md`.

## What it counts

A ticket is **re-measured** when its events show it reached `remeasured` (the repeat check at six weeks). For each of PHQ-9 and GAD-7:

- **Included**: the ticket's `ticket` and `scores` consents are both live, its bundle is not deleted, and the bundle's shared totals hold a referral total and a repeat total of that instrument. The repeat total is the newest one taken at or after the moment the check opened (six weeks after the event that made the ticket `seen`, `remeasureAvailableAt`); the referral total is the newest one taken before it. The API refuses a repeat total taken before that moment, so the split is exact.
- **Excluded**: any other re-measured ticket (no `scores` consent, consent stopped, share ended, bundle emptied, only one of the two totals, or a bundle that cannot be read). It is counted as excluded, per instrument.
- **Change** = repeat total minus referral total, so a fall means fewer symptoms. The mean is over the included tickets.
- **Reliable improvement** is a fall of at least the threshold, **reliable deterioration** a rise of at least it (`reliableChange` in `packages/rules`); the threshold value itself counts.

The period is the funnel's: a ticket belongs to the period of the root of its journey (the ticket it was rerouted from, if any).

## The thresholds and their source

`RELIABLE_CHANGE` in `packages/rules/src/config.ts`: **PHQ-9 6 points, GAD-7 4 points**.

Source (read in this run, not recalled): *The Improving Access to Psychological Therapies Manual: Appendices and helpful resources* (NCCMH, version 2), Table 1 "Clinical cut-offs and reliable change index": PHQ-9 caseness >= 10, reliable change >= 6; GAD-7 caseness >= 8, reliable change >= 4. Published at https://www.rcpsych.ac.uk/docs/default-source/improving-care/nccmh/iapt/nccmh-iapt-manual-appendices-helpful-resources-v2.pdf (the programme is now called NHS Talking Therapies).

The manual defines reliable improvement across both measures together (a reduction on either with no reliable increase on the other) and over everyone who completed a course of treatment. This dashboard reports each instrument on its own, over the re-measured tickets whose person shared both totals of it, which is a simpler and not an identical measure.

## What it reads, and what it never returns

The aggregate decrypts the shared bundle's `scores` on the server, only for tickets whose consents are live, and returns only counts, shares and a mean. No per-ticket figure, id or total leaves it. It is not a staff read of a bundle, so it writes no `bundle_reads` row. Stopping the scores, withdrawing, or "Delete everything" removes a ticket from the included figures at once, because the consents and the bundle are read live.

## How small numbers are kept out

The cells (re-measured, and per instrument included, excluded, improved, deteriorated, unchanged) are one `ProtectedTable` with two relations per instrument: re-measured = included + excluded, and included = improved + deteriorated + unchanged. `hiddenCells` / `pinnedCells` hide cells until no small number can be worked out from what is published; a share is also shown only when its part, its whole and what is left over each reach ten; the mean is shown only while the included count is.

The two instruments' included counts are tied, as equity ties its "no bucket given" groups. They count different, overlapping sets of the same re-measured tickets, so two published included counts that differ by 1 to 9 subtract into a small group (25 and 22 leaves three people with a PHQ-9 pair only). When the difference is from 1 to 9, both included cells are hidden, and with them (by the relations) both excluded cells, the means and the shares. A difference of ten or more, or none, publishes nothing small and leaves them independent. The re-measured count itself is never hidden by the tie or by the relations (the funnel publishes the same count, and hiding it would only follow from an instrument whose excluded count is nothing): it is hidden only when the funnel hides it, and with it shown no non-empty hidden cell becomes exactly derivable (`pinnedCells`, checked in the tests).

The figures stand on the same people as the funnel's last stage, so the whole response is hidden whenever the funnel hides that stage for the period (`remeasuredHiddenInFunnel`): nothing here can then be combined with the funnel to recover a number it hid.

Not covered, by decision: the same figure in two periods subtracts, as in the funnel and timeliness; and the funnel counts journeys while this counts tickets, which differ only where one journey holds two re-measured tickets (not reachable today).

## In the demo

The seeded tickets have no consent rows, so every seeded re-measured ticket is excluded: on the seeded data the dashboard shows the re-measured count and "Suppressed" for the rest. The browser gate makes thirty-two people who share and re-measure, so the figures can be seen.
