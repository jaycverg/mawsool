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
        const hits = all.flatMap(([key, text]) => labelsIn(text, locale).map((label) => `${key}: "${label}"`));
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

  it('is named in the safe-messaging checklist: every label of the fixed list is written there, in its language', () => {
    const checklist = normalise(readFileSync(CHECKLIST, 'utf8'));
    for (const locale of ['en', 'ar'] as const) {
      for (const label of DIAGNOSTIC_LABELS[locale]) expect(checklist, `${locale} "${label}" is missing from docs/safe-messaging-checklist.md`).toContain(normalise(label));
    }
  });
});
