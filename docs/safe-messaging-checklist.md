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
| A real person is the next step, with numbers as text and as tap-to-call | Met: three numbers, each as text and as a link | `crisis.hotlineTitle`, `hotlineDetail`, `callEmergency` |
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

## Diagnostic labels the person-facing copy never uses

A result tells a person what a score suggests and what it does not mean. It never tells them they have, suffer from or
were diagnosed with a condition. `apps/person/test/diagnostic-labels.test.ts` fails when any message a person reads
(`apps/person/messages` and `packages/ui/messages`, in both languages) contains one of the labels below, and fails when
this list and the test's list differ. The clinician app's messages are held to the same list. They name each instrument
by what it measures ("Depression (PHQ-9)", from the instrument's published title and the design board) beside a score and
its band: that names the measure and is not a statement about the person, and it stays only while no label below appears
there. A symptom word on its own ("anxiety", "mood") is not a label. Instrument item wording is published and is not part
of these files. Add a label here and in the test together.

The test reads the bullets under the six headings below, and only those, and compares each list to its own as a set: an
entry added here and not in the test, or left in the test and removed here, fails it, whatever the prose says.

A band word within three words of a condition word, in either order, is a label too, because it grades a condition the
person is told they have ("Moderate depression", "you have moderate depression", "severe anxiety", "mildly anxious",
"اكتئاب متوسط", "القلق الشديد"). The band and condition words are the lists headed "Band words" and "Condition words"
below, with their adverbs and a few synonyms ("mildly", "slight", "serious", "melancholia", "معتدل", "كآبة").

In Arabic the test also reads a word with something attached as the word itself: a conjunction (و, ف), a preposition
(ب, ك, ل) with or without the article (the definite article is ignored), the accusative ending (اكتئابًا), a plural and a
possessive (اكتئابك, قلقها). So "باكتئاب شديد" (with severe depression), "قلقًا شديدًا" and "اكتئابك الشديد" are labels
like their bare forms. A label of the first list is found the same way: "مصاب باكتئاب" and "تعاني من قلق" are found as
well as "مصاب بالاكتئاب". A label's own possessive stays on it: "تشخيصك" (your diagnosis) is a label, "تشخيصًا" (a
diagnosis, as in "ليس تشخيصًا") is not.

What the result card shows, which this check does not reach: the card names the instrument above the score ("Anxiety
(GAD-7)" in English, "القلق (GAD-7)" in Arabic; "Mood (PHQ-9)" and "المزاج (PHQ-9)" for the PHQ-9) and prints the band's name
("Moderate") beside the score and on the band bar, as separate elements. They sit in the same card, so a reader can
read the two together, but no message joins a band word to a condition word in one phrase, and the lists above hold the
messages to that. Whether a band printed beside a condition-named instrument counts as grading a condition is a product
question, not settled here.

English labels:

- you have depression, you have anxiety, you have a depressive, you have an anxiety disorder
- you are depressed, you're depressed, you suffer from, you are suffering from
- you have been diagnosed, you were diagnosed, diagnosed with, your diagnosis
- major depressive, major depression, clinical depression, depressive disorder, anxiety disorder
- generalised anxiety, generalized anxiety, bipolar, ptsd, post-traumatic, psychosis, schizophren
- mental illness, mental disorder

Arabic labels:

- لديك اكتئاب، لديك اضطراب، أنت مكتئب، أنت مصاب
- مصاب بالاكتئاب، مصاب بالقلق، تعاني من الاكتئاب، تعاني من اضطراب
- تم تشخيصك، شُخِّصت، تشخيصك
- اضطراب الاكتئاب، اضطراب اكتئابي، اضطراب القلق، اكتئاب سريري
- اضطراب ثنائي القطب، اضطراب ما بعد الصدمة، فصام، ذهان، اضطراب نفسي، مرض نفسي

Band words (English):

- minimal, minimally, mild, mildly, slight, slightly, moderate, moderately, severe, severely, serious, seriously

Condition words (English):

- depression, depressed, depressive, anxiety, anxious, melancholia

Band words (Arabic):

- طفيف، طفيفة، بسيط، بسيطة، خفيف، خفيفة، متوسط، متوسطة، معتدل، معتدلة، شديد، شديدة، حاد، حادة

Condition words (Arabic):

- اكتئاب، اكتئابي، مكتئب، قلق، كآبة

The Arabic labels, the Arabic band and condition words and the Arabic forms above were written for this build and have not
been read by a native Arabic speaker with mental health experience, so the lists may miss phrasings a native reader would flag.

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
