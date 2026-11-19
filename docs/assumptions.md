# Mawsool: assumptions

What the prototype takes for granted. Each assumption says what it is based on and what would change if it turned out
to be wrong. What the prototype does not do is in [`limitations.md`](limitations.md); how it works is in
[`technical-documentation.md`](technical-documentation.md).

## The problem

1. **The gap is after the screen, not before it.** People in Abu Dhabi are already being screened (through TAMM, health
   centres and schools); what is missing is someone who owns the next 14 days, so a positive screen too often ends with
   advice and no appointment. This is the product brief's framing. *Basis:* the product spec. *Not established:* a public
   figure for how many positive screens reach a specialist; none was found, so the prototype quotes no number.
2. **A visible deadline changes behaviour.** A ticket with a due date, a named receiving clinic and a day-7 check is
   assumed to make a stalled referral noticed and acted on. *If wrong:* the dashboard would still show where people are
   lost, which is the first thing a programme needs.

## Clinical

3. **The stepped-care thresholds and hand-off windows are reasonable starting points.** Which scores are offered which
   level of care, and the 7- and 14-day hand-off windows, are proposed defaults taken from the product spec. They are
   kept in one settings file so a clinical advisor can change them without touching the logic. *Not yet:* clinical
   sign-off.
4. **WHO-5, PHQ-9 and GAD-7 are suitable screens for this population**, with published cut-offs for their bands, and a
   WHO-5 score of 50 or less is a fair point to offer the longer questionnaires.
5. **"Reliable change" means a move of 6 points on PHQ-9 or 4 points on GAD-7,** the convention of England's NHS Talking
   Therapies manual. It is used both to warn a person who is getting worse and to count improvement on the dashboard.
6. **Any answer above "not at all" to PHQ-9 question 9, or any "yes" on the C-SSRS screener, warrants the crisis screen
   immediately.** The prototype is deliberately cautious: it prefers showing the crisis screen to someone who did not need
   it over missing someone who did.
7. **A screen is not a diagnosis.** Every result says what it means and what it does not mean, and never names a condition.
8. **Six weeks after being seen is the right time for a repeat check.**

## Local services and context

9. **800-SAKINA (800 725462) is a live, 24-hour, bilingual line, and 999 (police) and 998 (ambulance) are the emergency
   numbers.** Taken from the Department of Health's announcement cited in the spec. Nobody on the team has called the
   line to confirm it, so the admin view shows each number as not yet confirmed.
10. **The care options are the kinds Abu Dhabi offers:** self-help, community support, tele-consultation, a trained GP at
    a primary health centre, and a specialist, across Abu Dhabi city, Al Ain and Al Dhafra. The 24 services in the
    directory are invented examples, labelled "Sample data".
11. **Insurance coverage can be shown as an indication.** Thiqa, Daman Basic, Daman Enhanced, other private and "not
    sure" are shown as covered, co-pay, pay and claim, or unknown. The table is invented from two examples in the spec
    and always says "Indicative only — verify with your insurer".
12. **A clinic can receive referrals in a standard format.** The export is built in FHIR R4, on the assumption that this
    is a format Malaffi (Abu Dhabi's health information exchange) can take, and is called "Malaffi-ready". Neither that
    nor how a new referral source joins Malaffi has been confirmed, so nothing is sent.
13. **Existing front doors would send a positive screen if they could.** TAMM, health centres and school programmes are
    assumed willing to hand a person over with a signed message; the prototype shows this with a mock TAMM page.
14. **Some clinics will not use a new portal,** so a clinic can be given a one-time link that works without signing in.
15. **Arabic and English cover the people the service is first aimed at.** The app's text is written in those two
    languages. Urdu, Hindi and Tagalog appear as care languages: a person can ask for one, a service can offer it, and
    matching compares the two. A person can also report one as their language for the equity view, and the seed uses
    Urdu to show how the dashboard finds a group that is being left behind.
16. **The service runs on UAE time** (Gulf Standard Time, no daylight saving).

## People and privacy

17. **People will use a mental-health service more readily if they do not have to give their name.** The app needs no
    name, email, Emirates ID or phone number; a phone number is asked for only if the person wants text reminders or a
    callback from the crisis line, and is optional even then.
18. **The person decides what each clinic sees, item by item,** and can take it back; taking it back deletes the copy the
    clinic could see.
19. **Employers and insurers must never see a person's wellbeing data,** so no such role exists in the system.
20. **Groups smaller than 10 people must never be shown,** so every number under 10 on the dashboard is hidden, along
    with any number in the same view that would let it be worked out (the exceptions are in
    [`limitations.md`](limitations.md), item 13).
21. **Equity can be measured from four coarse groupings the person opts in to:** age band, gender, language and region.
    Nationality is left out until the programme team chooses its groupings.
22. **An opt-in that has not been used for about six months should end by itself,** because a person who cleared their
    browser can no longer switch it off.

## Technology and operation

23. **A web app is enough to start.** The person's app installs from the browser and works offline; it is built so it can
    later be wrapped as an App Store or Play Store app without rewriting it.
24. **A language model may help write the referral note, and nothing else.** It is off by default, sees only what the
    person agreed to share, and the person edits and approves every word. Using it with real people assumes the hosting
    region and model provider meet UAE health-data and Department of Health AI rules; that has not been checked.
25. **One API and one Postgres database serve everyone,** hosted in a region that meets UAE data-residency rules.
26. **Staff can be sent a sign-in link,** and clinics a link, by email or text in a real deployment. In the prototype
    these are written to the server log instead.

## The demo

27. **Synthetic data tells the story honestly.** The seed holds 500 simulated tickets over 90 days and 40 crisis events.
    It plants one equity gap on purpose: Urdu-language tickets close the loop about 20 points below the overall rate. The
    same seed always produces the same data. The demo adds two personas: resetting the demo creates the TAMM invite for
    Noura, who is referred through TAMM, and Rashid, who reaches the crisis screen, needs nothing prepared.
28. **Moving the clock forward is a fair way to show weeks of care in six minutes.** The demo clock moves only the care
    timeline (deadlines, day-7 check, repeat check); security timers stay on real time.

Source: the product spec (`docs/product-spec.md`, including its "Open questions and facts to verify"), the settings file
`packages/rules/src/config.ts`, the instrument sources `packages/instruments/SOURCES.md`, the seed
(`apps/api/src/seed/generate.ts`) and the project rules in `CLAUDE.md`, all at commit `fc1aedd`.
