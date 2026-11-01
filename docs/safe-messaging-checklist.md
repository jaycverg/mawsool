# Safe-messaging checklist for the crisis copy

Self-check of the crisis screen and the copy around it against common safe-messaging guidance. It is a check made
by the people building the app, from reading the strings. **It is not a clinical review and not a sign-off.** The
open items at the end need a clinician or a native Arabic reader before the copy is relied on.

Source of the strings: `apps/person/messages/en.json` and `ar.json`, namespaces `crisis` (the screen) and `settings`
(`numbersBody`). The numbers come from `packages/rules/src/config.ts`.

## Checks

| Check | Result | Where it shows |
| ----- | ------ | -------------- |
| No detail about methods, means, places or timing | Met: no such wording anywhere in the namespace | all `crisis.*` |
| The screen does not say what the person answered, or name self-harm or suicide | Met: it says "something very painful" and nothing more | `crisis.body` |
| Hopeful and calm, never alarming; no countdown, no red warning text | Met by copy; the call buttons are red, which is the one alarm-coloured element | `crisis.heading`, `crisis.body` |
| Reaching out is framed as a strength, not a failure | Met: "It is good that you reached out" | `crisis.reachedThanks` |
| No blame, no pressure to explain, no "you should" | Met: every action is an offer ("Call now", "I'm with someone safe") | `crisis.callNow`, `withSomeone`, `safeNow` |
| A real person is the next step, with numbers as text and as tap-to-call | Met: three numbers, each as text and as a link | `crisis.callSakina`, `call998`, `call999` |
| The way out is the person's choice; nothing dismisses itself | Met: only two buttons release the screen; no timer, no swipe | `crisis.withSomeone`, `safeNow` |
| Emergency numbers stay visible after the person says they are safe | Met: "Help now" is on every other screen and goes straight here | `common.helpNow` |
| Works without internet | Met: the screen and its numbers are in the page itself, precached by the service worker | `crisis.offline` |
| The same standard in Arabic | Met by reading; see the open items | `ar.json` |
| "Did you reach someone?" does not press for a yes | Met: "Yes, I spoke to someone" and "Not yet" are equal buttons, and "Not yet" is answered kindly | `crisis.reachedTitle`, `reachedNo`, `reachedLater` |
| The text avoids labels and diagnoses | Met: no diagnostic word on the screen | all `crisis.*` |

## Copy awaiting clinical review

These live under the message namespace `clinicalCopy` in both languages, and are marked there for review:

- the "what this means" line for each severity band of the PHQ-9 and GAD-7, and for the two WHO-5 outcomes;
- the "what it does not mean" line shown on every result.

## Open items

- A clinician has not reviewed any of this copy.
- The Arabic strings were written for this build and have not been read by a native Arabic speaker with mental
  health experience. They reuse the boards' Arabic where the boards had it.
- The line is described on the screen as "24/7" and "Arabic and English", which is the spec's wording. The
  spec says 800-SAKINA could not be independently confirmed as live, 24/7 and bilingual as of August 2026, and
  `last_verified` for every number in `config.ts` is `null`. Someone must call it and fill the date before launch.
- The ambulance and police numbers (998, 999) are taken from the spec and not independently confirmed either.
- "I'm with someone safe" and "I'm safe right now" both release the block. Whether "with someone safe" should keep
  the numbers pinned for longer is a clinical decision that has not been made.
