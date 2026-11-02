import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const CHECKLIST = join(ROOT, 'docs', 'safe-messaging-checklist.md');

type Locale = 'ar' | 'en';
type Tree = { [key: string]: string | Tree };

/**
 * The diagnostic labels no person-facing message may use, in each language. A result says what a score suggests and what
 * it does not mean; it never tells a person they have, suffer from or were diagnosed with a condition. The list is fixed
 * here, and `docs/safe-messaging-checklist.md` names the same entries (a test below fails when they drift apart). Adding a
 * label means adding it in both places. A symptom word on its own ("anxiety", "mood") is not a label; the phrases below
 * are the ones that assert or name a condition.
 */
const DIAGNOSTIC_LABELS: Record<Locale, string[]> = {
  en: [
    'you have depression',
    'you have anxiety',
    'you have a depressive',
    'you have an anxiety disorder',
    'you are depressed',
    "you're depressed",
    'you suffer from',
    'you are suffering from',
    'you have been diagnosed',
    'you were diagnosed',
    'diagnosed with',
    'your diagnosis',
    'major depressive',
    'major depression',
    'clinical depression',
    'depressive disorder',
    'anxiety disorder',
    'generalised anxiety',
    'generalized anxiety',
    'bipolar',
    'ptsd',
    'post-traumatic',
    'psychosis',
    'schizophren',
    'mental illness',
    'mental disorder',
  ],
  ar: [
    'لديك اكتئاب',
    'لديك اضطراب',
    'أنت مكتئب',
    'أنت مصاب',
    'مصاب بالاكتئاب',
    'مصاب بالقلق',
    'تعاني من الاكتئاب',
    'تعاني من اضطراب',
    'تم تشخيصك',
    'شُخِّصت',
    'تشخيصك',
    'اضطراب الاكتئاب',
    'اضطراب اكتئابي',
    'اضطراب القلق',
    'اكتئاب سريري',
    'اضطراب ثنائي القطب',
    'اضطراب ما بعد الصدمة',
    'فصام',
    'ذهان',
    'اضطراب نفسي',
    'مرض نفسي',
  ],
};

/**
 * A label is also a band word within `BAND_WINDOW` words of a condition word, in either order: "moderate depression",
 * "severe anxiety", "اكتئاب متوسط". It grades a condition the person is told they have, which a result must not do; it may
 * name a band ("mild") and say what the score suggests, never join the two. Named in the checklist, like the labels.
 */
const BAND_WORDS: Record<Locale, string[]> = {
  en: ['minimal', 'mild', 'moderate', 'moderately', 'severe', 'severely'],
  ar: ['طفيف', 'بسيط', 'بسيطة', 'خفيف', 'خفيفة', 'متوسط', 'متوسطة', 'شديد', 'شديدة', 'حاد', 'حادة'],
};
const CONDITION_WORDS: Record<Locale, string[]> = {
  en: ['depression', 'depressed', 'depressive', 'anxiety', 'anxious'],
  ar: ['اكتئاب', 'اكتئابي', 'مكتئب', 'قلق'],
};
const BAND_WINDOW = 3;

/** Lower case, one kind of apostrophe and space, and Arabic without its marks, tatweel or alef variants, so spelling cannot hide a label. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/\s+/g, ' ');
}

/** The labels from the fixed list that a text contains. */
function labelsIn(text: string, locale: Locale): string[] {
  const body = normalise(text);
  return DIAGNOSTIC_LABELS[locale].filter((label) => body.includes(normalise(label)));
}

/** The words of a text, normalised, with the Arabic definite article (and a one-letter preposition before it) taken off. */
function words(text: string): string[] {
  return normalise(text)
    .split(/[^\p{L}]+/u)
    .filter((word) => word !== '')
    .map((word) => word.replace(/^[وفبل]?ال(?=\p{L}{2})/u, ''));
}

/** Each band word that stands within `BAND_WINDOW` words of a condition word, as "band condition" pairs. */
function bandedConditionsIn(text: string, locale: Locale): string[] {
  const tokens = words(text);
  const band = new Set(BAND_WORDS[locale].map(normalise));
  const condition = new Set(CONDITION_WORDS[locale].map(normalise));
  const hits: string[] = [];
  tokens.forEach((token, at) => {
    if (!band.has(token)) return;
    for (let other = Math.max(0, at - BAND_WINDOW); other <= Math.min(tokens.length - 1, at + BAND_WINDOW); other += 1) {
      if (other !== at && condition.has(tokens[other]!)) hits.push(`${token} ${tokens[other]}`);
    }
  });
  return hits;
}

/** Everything that makes a text a diagnostic label: a phrase of the fixed list, or a band word beside a condition word. */
function violationsIn(text: string, locale: Locale): string[] {
  return [...labelsIn(text, locale), ...bandedConditionsIn(text, locale)];
}

/**
 * The entries of the bullet list under a heading line of the checklist: only the bullets that follow the heading, so
 * prose elsewhere in the document cannot stand in for a list entry. An entry is a comma-separated item (Latin or Arabic comma).
 */
function checklistList(heading: string): Set<string> {
  const lines = readFileSync(CHECKLIST, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) throw new Error(`docs/safe-messaging-checklist.md has no "${heading}" heading`);
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('- ')) entries.push(...line.slice(2).split(/[,،]/).map((entry) => entry.trim()).filter((entry) => entry !== ''));
    else if (line.trim() !== '' || entries.length > 0) break;
  }
  return new Set(entries);
}

function leaves(tree: Tree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[prefix ? `${prefix}.${key}` : key, value] as [string, string]] : leaves(value, prefix ? `${prefix}.${key}` : key)));
}

/**
 * The message files a person reads: the person app's own and the shared ones every app uses. The clinician app's are
 * checked too: it shows the instrument's name ("Depression (PHQ-9)") beside a score, which names what was measured and
 * must never become a statement about the person.
 */
const PERSON_FACING: [dir: string, atLeast: number][] = [
  ['apps/person/messages', 400],
  ['packages/ui/messages', 15],
  ['apps/clinician/messages', 100],
];
const messages = (dir: string, locale: Locale) => leaves(JSON.parse(readFileSync(join(ROOT, dir, `${locale}.json`), 'utf8')) as Tree);

describe('no diagnostic label in a message a person reads (MW-103)', () => {
  for (const locale of ['en', 'ar'] as const) {
    for (const [dir, atLeast] of PERSON_FACING) {
      it(`${dir}/${locale}.json holds none of the ${DIAGNOSTIC_LABELS[locale].length} labels`, () => {
        const all = messages(dir, locale);
        // A scan of a file that was not read proves nothing: the file must hold the messages it is known to.
        expect(all.length).toBeGreaterThanOrEqual(atLeast);
        const hits = all.flatMap(([key, text]) => violationsIn(text, locale).map((label) => `${key}: "${label}"`));
        expect(hits).toEqual([]);
      });
    }
  }

  it('finds a label in the wording a person must never be given, in both languages, whatever the spelling', () => {
    expect(labelsIn('Your answers show that you have depression.', 'en')).toEqual(['you have depression']);
    expect(labelsIn("You're Depressed", 'en')).toEqual(["you're depressed"]);
    expect(labelsIn('You’re depressed', 'en')).toEqual(["you're depressed"]);
    expect(labelsIn('This may be an Anxiety   Disorder', 'en')).toEqual(['anxiety disorder']);
    expect(labelsIn('You have been diagnosed with something.', 'en')).toEqual(['you have been diagnosed', 'diagnosed with']);
    expect(labelsIn('لديك اكتئاب', 'ar')).toEqual(['لديك اكتئاب']);
    expect(labelsIn('انت مصاب بالاكتئاب', 'ar')).toEqual(['أنت مصاب', 'مصاب بالاكتئاب']);
    expect(labelsIn('أنتَ مُكتئبٌ', 'ar')).toEqual(['أنت مكتئب']);
    expect(labelsIn('تعاني من الاكتــئاب', 'ar')).toEqual(['تعاني من الاكتئاب']);
  });

  it('lets through the wording the result screens use: a score suggests, and a screen is not a diagnosis', () => {
    expect(labelsIn('Your answers suggest anxiety at a level where talking to a trained professional usually helps.', 'en')).toEqual([]);
    expect(labelsIn('This is a screening questionnaire, not a diagnosis. Only a clinician can diagnose.', 'en')).toEqual([]);
    expect(labelsIn('هذا استبيان فحص وليس تشخيصاً. المختص وحده يستطيع التشخيص.', 'ar')).toEqual([]);
    expect(labelsIn('تشير إجاباتك إلى قلق بمستوى يفيد معه عادةً التحدث إلى مختص مدرَّب.', 'ar')).toEqual([]);
  });

  it('finds a band word beside a condition word, in both languages, in either order and with the definite article', () => {
    expect(bandedConditionsIn('You have moderate depression.', 'en')).toEqual(['moderate depression']);
    expect(bandedConditionsIn('Moderate depression', 'en')).toEqual(['moderate depression']);
    expect(bandedConditionsIn('Severe anxiety', 'en')).toEqual(['severe anxiety']);
    expect(bandedConditionsIn('The depression is severe', 'en')).toEqual(['severe depression']);
    expect(bandedConditionsIn('Moderately severe depression', 'en')).toEqual(['moderately depression', 'severe depression']);
    expect(bandedConditionsIn('اكتئاب متوسط', 'ar')).toEqual(['متوسط اكتئاب']);
    expect(bandedConditionsIn('القلق الشديد', 'ar')).toEqual(['شديد قلق']);
    expect(bandedConditionsIn('أنتَ تعاني من اكتئابٍ شديدٍ', 'ar')).toEqual(['شديد اكتئاب']);
    // And a label of any kind is a violation: the phrase list and the pattern are checked together.
    for (const [text, locale] of [['You have moderate depression', 'en'], ['Moderate depression', 'en'], ['Severe anxiety', 'en'], ['اكتئاب متوسط', 'ar']] as const) {
      expect(violationsIn(text, locale), text).not.toEqual([]);
    }
  });

  it('lets through a band named on its own and a condition word that is not graded, and words too far apart to be one phrase', () => {
    expect(bandedConditionsIn('Your answers suggest some worry or anxiety symptoms. Many people feel this way at times.', 'en')).toEqual([]);
    expect(bandedConditionsIn('Band: moderate. Next, the questions about anxiety (GAD-7).', 'en')).toEqual([]);
    expect(bandedConditionsIn('A mild day, and later in the week we talk about anxiety', 'en')).toEqual([]);
    expect(bandedConditionsIn('تشير إجاباتك إلى قلق يؤثر في أيامك بدرجة كبيرة.', 'ar')).toEqual([]);
    expect(bandedConditionsIn('أجب عن أسئلة المزاج والقلق', 'ar')).toEqual([]);
    expect(bandedConditionsIn('متوسط', 'ar')).toEqual([]);
  });

  it('is named in the safe-messaging checklist: each list under its heading holds exactly the entries the test holds, both ways', () => {
    const lists: [heading: string, entries: string[]][] = [
      ['English labels:', DIAGNOSTIC_LABELS.en],
      ['Arabic labels:', DIAGNOSTIC_LABELS.ar],
      ['Band words (English):', BAND_WORDS.en],
      ['Condition words (English):', CONDITION_WORDS.en],
      ['Band words (Arabic):', BAND_WORDS.ar],
      ['Condition words (Arabic):', CONDITION_WORDS.ar],
    ];
    for (const [heading, entries] of lists) {
      const written = checklistList(heading);
      expect([...written].filter((entry) => !entries.includes(entry)), `${heading} in the checklist but not in the test`).toEqual([]);
      expect(entries.filter((entry) => !written.has(entry)), `${heading} in the test but not in the checklist`).toEqual([]);
    }
  });

  it('reads a list only from its bullets: an entry that is only in the prose around the lists is not in the list', () => {
    expect(checklistList('English labels:').has('diagnosed with')).toBe(true);
    // The introduction says "were diagnosed with a condition" in a sentence; that sentence is not a bullet and is not read.
    expect(checklistList('English labels:').has('were diagnosed with a condition')).toBe(false);
    expect(() => checklistList('No such heading:')).toThrow(/no "No such heading:" heading/);
  });
});
