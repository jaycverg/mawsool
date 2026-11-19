# Mawsool: limitations

What the prototype does not do, or does not do yet. The first section is what stands between this prototype and use
with real people; the rest are known gaps, each with what it means in practice. The assumptions behind the design are
in [`assumptions.md`](assumptions.md).

## Not ready for real people yet

1. **No clinical sign-off.** The thresholds that decide which care is offered, the hand-off windows, and the wording of
   every result ("what this means / what it does not mean") are proposed defaults. They are marked for clinical review
   and have not had it.
2. **The Arabic questionnaires are not validated for the UAE.** Only the English PHQ-9 and GAD-7 have published validated
   wording behind them. The Arabic PHQ-9 and GAD-7 are the published Tunisian editions; the Arabic WHO-5 was transcribed by
   hand from a 1999 scan; the English WHO-5 has no validation study cited. Every one of these shows a visible "wording not
   verified" label in the app.
3. **No native Arabic speaker has reviewed the app's text,** the Arabic names of the sample services, or the crisis
   wording. The crisis copy was checked against safe-messaging guidance by the team ([`safe-messaging-checklist.md`](safe-messaging-checklist.md)); that is a self-check, not a clinical review.
4. **The C-SSRS suicide-risk screener is not asked.** Its questions, scoring and crisis trigger are built and tested, but
   no screen presents it in this version, and no Arabic text of it was obtained. Today the crisis screen is reached through
   PHQ-9 question 9.
5. **The crisis line number has not been confirmed live.** 800-SAKINA, 999 and 998 come from the spec and an official
   announcement; nobody has called them. The admin view shows each as not yet confirmed.
6. **Licences are not cleared.** The WHO-5 is published under a non-commercial, share-alike licence whose terms need a
   legal read before any use beyond a demo, and the terms for using the C-SSRS screener in this app are not established.
7. **Data residency and AI rules are not checked.** Before the optional note-writing assistant is used outside a demo, the
   hosting region and the model provider must be confirmed against UAE health-data and Department of Health AI rules.
8. **No security audit, penetration test, load test or clinical safety review** has been done. The automated checks cover
   the cases the team wrote down.

## What is a mock

Each of these is labelled "Sample" or "Mock" on screen, and the browser tests check the labels. The one exception is the
staff sign-in message, which is written to the server log and has no screen of its own.

| Part                       | In the prototype                                                    | In a real service                                   |
| -------------------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| Service directory          | 24 invented services                                                | The real directory, kept current                    |
| Insurance coverage         | An invented indicative table                                        | Current policy wording or an eligibility check      |
| Malaffi                    | A FHIR export the clinic can copy; nothing is sent                  | Onboarding and posting through Malaffi              |
| TAMM, health centre, school | A mock TAMM result page and signed test messages                   | Agreements and keys with each front door            |
| Text messages and email    | Written to the server log; nothing is sent                          | A real SMS, WhatsApp or email provider              |
| Crisis-line console        | A mock console that receives the person's optional note             | The line's own systems                              |
| Clinic and patient data    | 500 simulated tickets, two demo personas, sample lab values         | Real records                                        |

Source: `docs/running-the-demo.md`, the mock-label checks in `apps/person/e2e/gate-c.spec.ts` (with the crisis console's
in `phase4-acceptance.spec.ts` and the text-reminder sample's in `phase3-acceptance.spec.ts`), and the seed
(`apps/api/src/seed/generate.ts`) at commit `fc1aedd`.

**What this tells us**
- The ticket, consent, deadline and dashboard logic is real; what surrounds it is simulated.
- The mocks sit at the edges: the directory is a table, insurance is one settings table, messages go through one
  messaging interface, and TAMM is a separate page. Replacing them should not change the ticket or consent logic, but
  that has not been tried.
- None of the mocks has been tried against the real system it stands in for.

## Product gaps

9. **Crises in anonymous mode are not counted.** Anonymous mode sends nothing to the server, so a crisis screen shown in
   that mode never reaches the dashboard.
10. **The equity view has no nationality grouping** until the programme team chooses one.
11. **Reminders appear only when the app is opened.** A web app cannot schedule a notification in the background; a
    native wrapper would fix this. Text reminders are a labelled sample and send nothing.
12. **Some staff-facing text is English only.** The clinician and ops apps show services by their English names, and the
    sign-in messages to staff are English. The screens themselves are in Arabic and English.
13. **The dashboard does not stop every subtraction.** It hides small numbers within one view, but a determined reader
    could sometimes work one out by comparing figures between funnel stages or between two time periods. This was a
    deliberate choice for the prototype.
14. **The symptom-change figures cover the last 90 days only,** and count only people who opted in to anonymous
    statistics.
15. **The repeat check stays open indefinitely** once six weeks have passed.
16. **The crisis-line note has rough edges in failure cases.** If the phone's storage breaks, the message may tell the
    person to try again when online rather than naming the real cause; and Stop is not offered during the first send
    (up to 15 seconds). The crisis numbers work throughout.
17. **A phone that stays offline keeps showing a setting as on** after the server has switched it off. Nothing is sent as
    on without asking the server first.

## Technical limits

18. **Hosted only for the demo.** A copy runs on an Azure free trial behind Cloudflare, on sample data: one API replica,
    a burstable database with the default automatic backups (restore not tested), and no scaling set up. It is a demo, not
    a service: everything typed into it is visible to everyone using it, and it is reset every night.
19. **Tested in Chromium only.** The browser tests run in Chromium; the anonymous mode's clean-up relies on browser
    features (Web Locks, listing databases) that are unproven in Safari and Firefox.
20. **Foundry not tried live.** The optional note assistant can reach Claude through Anthropic's API or Microsoft
    Foundry. The Foundry route is tested against a stand-in, but has not been tried against a real Foundry deployment.
21. **Demo clock overlap.** In demo mode, the every-minute deadline check can overlap a demo reset. This affects demos
    only.
22. **A CI timeout, since fixed.** On 2026-11-14 the `verify` job on GitHub stopped when the first case of the test that
    proves the "no AI outside the summary package" lint rule took 5.2 seconds against its 5-second limit. `02e18f8` loads
    ESLint once before those cases; CI has passed in full on every push to the main branch since.
23. **Test precision.** Some browser and unit checks are weaker than they look: for example, real two-tab behaviour of some
    settings is not tested, and neither is the cancellation when registering a phone passes its 10-second limit.

Source: the open items in the build's final report (2026-11-14), `CLAUDE.md`, `packages/instruments/SOURCES.md`,
`docs/safe-messaging-checklist.md`, `docs/two-clocks.md`, `apps/person/components/CheckInFlow.tsx` (C-SSRS) and GitHub
Actions run 43542562936, all at or for commit `fc1aedd` (the run lists it under its earlier ID, `ce088c9`).
