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
  en: ['minimal', 'minimally', 'mild', 'mildly', 'slight', 'slightly', 'moderate', 'moderately', 'severe', 'severely', 'serious', 'seriously'],
  ar: ['طفيف', 'طفيفة', 'بسيط', 'بسيطة', 'خفيف', 'خفيفة', 'متوسط', 'متوسطة', 'معتدل', 'معتدلة', 'شديد', 'شديدة', 'حاد', 'حادة', 'بشدة', 'قليلا'],
};
const CONDITION_WORDS: Record<Locale, string[]> = {
  en: ['depression', 'depressed', 'depressive', 'anxiety', 'anxious', 'melancholia'],
  ar: ['اكتئاب', 'اكتئابي', 'مكتئب', 'قلق', 'كآبة'],
};
const BAND_WINDOW = 3;

/** Lower case, one kind of apostrophe and space, and Arabic without its marks, tatweel or alef variants and with a final ه as ة, so spelling cannot hide a label. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    // A final ه is written for ة in everyday Arabic ("متوسطه"), so the two are one letter here.
    .replace(/ه(?!\p{L})/gu, 'ة')
    .replace(/\s+/g, ' ');
}

/**
 * What Arabic attaches to a word: a conjunction (و, ف), a preposition (ب, ك, ل) with or without the article (بال, كال, لل
 * for ل + ال), and at the end the accusative alef, the plural and the possessive pronouns. "باكتئاب" (with depression),
 * "للقلق" (to the anxiety), "اكتئابًا" (accusative, after normalising: اكتئابا) and "اكتئابك" (your depression) are all
 * the word "اكتئاب" with something attached, and must not slip past a list written with the bare word.
 */
const ARABIC_CONJUNCTIONS = ['', 'و', 'ف'];
const ARABIC_PREFIXES = ['', 'ب', 'ك', 'ل', 'ال', 'بال', 'كال', 'لل'];
/**
 * What ends a word: the accusative alef, the feminine (ة, which also makes "اكتئابية" the listed "اكتئابي"), the plural (ات, ين, ون)
 * and the possessive pronouns. A final ه was already written as ة, so "his" (اكتئابه) is the feminine ending here and strips the same way.
 */
const ARABIC_SUFFIXES = ['', 'ا', 'ة', 'ات', 'ين', 'ون', 'ك', 'ها', 'نا', 'كم', 'هم', 'هن', 'ي'];
/** Words that look like a band word with something attached and are another word: "الحادي" is "the eleventh", not "حاد". */
const NOT_A_GRADE = new Set(['حادي']);
/** A word is never cut down to fewer letters than this, so a short word does not become another word. */
const MIN_STEM = 3;

/** A word of a text, as itself and as each shorter word it can be with something attached: its stems. */
function stems(token: string): Set<string> {
  const found = new Set([token]);
  if (!/\p{Script=Arabic}/u.test(token)) return found;
  for (const conjunction of ARABIC_CONJUNCTIONS) {
    for (const prefix of ARABIC_PREFIXES) {
      for (const suffix of ARABIC_SUFFIXES) {
        const head = conjunction + prefix;
        if (!token.startsWith(head) || !token.endsWith(suffix)) continue;
        const stem = token.slice(head.length, token.length - suffix.length);
        if (stem.length >= MIN_STEM) found.add(stem);
      }
    }
  }
  return found;
}

/** The words of a text, normalised. */
function words(text: string): string[] {
  return normalise(text)
    .split(/[^\p{L}]+/u)
    .filter((word) => word !== '');
}

/** The labels from the fixed list that a text contains, as a phrase of its words or (in Arabic) as the same words with something attached. */
function labelsIn(text: string, locale: Locale): string[] {
  const body = normalise(text);
  const tokens = words(text);
  return DIAGNOSTIC_LABELS[locale].filter((label) => {
    if (body.includes(normalise(label))) return true;
    if (locale !== 'ar') return false;
    // The label's own words are the fixed side (with the article taken off: "بالاكتئاب" is "اكتئاب"); the text's words may
    // carry anything Arabic attaches. A label's own possessive stays on it: "تشخيصك" (your diagnosis) is not "تشخيصا" (a diagnosis).
    const phrase = words(label).map((word) => word.replace(/^(?:بال|كال|لل|ال)(?=\p{L}{3})/u, ''));
    // A verb ending in ي ("تعاني") is also found as its stem with the plural or feminine ending on ("تعانين", "تعانون").
    const forms = (word: string) => (word.endsWith('ي') && word.length > MIN_STEM ? [word, word.slice(0, -1)] : [word]);
    return tokens.some((_, at) => phrase.every((word, offset) => tokens[at + offset] !== undefined && forms(word).some((form) => stems(tokens[at + offset]!).has(form))));
  });
}

/** The word of a list that a token is, with or without something attached; undefined when it is none of them. */
function listed(token: string, list: ReadonlySet<string>): string | undefined {
  return [...stems(token)].find((stem) => list.has(stem));
}

/** Each band word that stands within `BAND_WINDOW` words of a condition word, as "band condition" pairs. */
function bandedConditionsIn(text: string, locale: Locale): string[] {
  const tokens = words(text);
  const band = new Set(BAND_WORDS[locale].map(normalise));
  const condition = new Set(CONDITION_WORDS[locale].map(normalise));
  const hits: string[] = [];
  tokens.forEach((token, at) => {
    const grade = listed(token, band);
    if (grade === undefined || [...stems(token)].some((stem) => NOT_A_GRADE.has(stem))) return;
    for (let other = Math.max(0, at - BAND_WINDOW); other <= Math.min(tokens.length - 1, at + BAND_WINDOW); other += 1) {
      const name = other === at ? undefined : listed(tokens[other]!, condition);
      if (name !== undefined) hits.push(`${grade} ${name}`);
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

  /**
   * One text per form a word takes that a list written with the bare word would miss. Each is a violation, with the
   * entry it is found as; none of them was found before the attached forms were read.
   */
  const MUST_FAIL: [form: string, text: string, locale: Locale, found: string[]][] = [
    ['a bare preposition before a band and a condition', 'باكتئاب شديد', 'ar', ['شديد اكتئاب']],
    ['a bare preposition inside a label (no article)', 'مصاب باكتئاب', 'ar', ['مصاب بالاكتئاب']],
    ['a bare preposition and "to" with the article, in a label', 'تعاني من اكتئاب', 'ar', ['تعاني من الاكتئاب']],
    ['a conjunction and a preposition before the condition', 'وبقلق متوسط', 'ar', ['متوسط قلق']],
    ['the accusative (tanween) on both words', 'قلقًا شديدًا', 'ar', ['شديد قلق']],
    ['the accusative with the alef before the tanween', 'اكتئابًا متوسطًا', 'ar', ['متوسط اكتئاب']],
    ['a possessive suffix on the condition', 'اكتئابك الشديد', 'ar', ['شديد اكتئاب']],
    ['a possessive suffix on the condition, band first', 'المتوسط في قلقها', 'ar', ['متوسط قلق']],
    ['a synonym for the condition', 'كآبة متوسطة', 'ar', ['متوسطة كابة']],
    ['the feminine ending on the condition', 'قلقة شديدة', 'ar', ['شديدة قلق']],
    ['the adjective ending on the condition', 'أعراض اكتئابية متوسطة', 'ar', ['متوسطة اكتئابي']],
    ['the adverb "severely" with the condition', 'مكتئب بشدة', 'ar', ['بشدة مكتئب']],
    ['the adverb "severely" with the feminine condition', 'مكتئبة بشدة', 'ar', ['بشدة مكتئب']],
    ['the adverb "a little" with the condition', 'مكتئب قليلاً', 'ar', ['قليلا مكتئب']],
    ['the plural ending on the condition (-ين)', 'مكتئبين بشدة', 'ar', ['بشدة مكتئب']],
    ['the plural ending on the condition (-ون)', 'مكتئبون بشدة', 'ar', ['بشدة مكتئب']],
    ['a final ه for ة', 'كآبه متوسطه', 'ar', ['متوسطة كابة']],
    ['the feminine form inside a label', 'مصابة بالاكتئاب', 'ar', ['مصاب بالاكتئاب']],
    ['the feminine verb ending inside a label', 'تعانين من الاكتئاب', 'ar', ['تعاني من الاكتئاب']],
    ['the plural verb ending inside a label', 'تعانون من الاكتئاب', 'ar', ['تعاني من الاكتئاب']],
    ['a synonym for the band', 'قلق معتدل', 'ar', ['معتدل قلق']],
    ['the adverb "mildly"', 'You are mildly anxious.', 'en', ['mildly anxious']],
    ['the adverb "mildly" before a different condition word', 'Mildly depressed', 'en', ['mildly depressed']],
    ['a synonym for the band', 'serious depression', 'en', ['serious depression']],
    ['a synonym for the condition', 'a moderate melancholia', 'en', ['moderate melancholia']],
  ];
  for (const [form, text, locale, found] of MUST_FAIL) {
    it(`finds ${form}: "${text}"`, () => {
      expect(violationsIn(text, locale)).toEqual(found);
    });
  }

  it('lets through a plain diagnosis word an attached ending does not turn into "your diagnosis", and a band or condition word apart from the other', () => {
    expect(labelsIn('هذا استبيان فحص وليس تشخيصًا.', 'ar')).toEqual([]);
    expect(labelsIn('تشخيصه', 'ar')).toEqual([]);
    expect(labelsIn('تشخيصك', 'ar')).toEqual(['تشخيصك']);
    expect(violationsIn('باكتئاب', 'ar')).toEqual([]);
    expect(violationsIn('قلقك', 'ar')).toEqual([]);
    expect(violationsIn('درجة متوسطة', 'ar')).toEqual([]);
    expect(violationsIn('mildly', 'en')).toEqual([]);
    // "الحادي" is "the eleventh", not the band word "حاد" with an ending, even three words from "القلق".
    expect(violationsIn('اليوم الحادي عشر ثم القلق', 'ar')).toEqual([]);
    expect(violationsIn('اليوم الحادي عشر', 'ar')).toEqual([]);
    expect(violationsIn('Your answers suggest a slightly higher score than last time.', 'en')).toEqual([]);
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
