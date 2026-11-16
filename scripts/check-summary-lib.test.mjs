// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONSENTED_ELEMENTS,
  DRAFT_TIME_LIMIT_MS,
  DRAFT_WORD_LIMIT,
  LISTED_TERMS,
  PRIVATE_MARKER,
  PRIVATE_PHRASES,
  checkDraft,
  draftRequest,
  nonLoopbackHost,
  templateHint,
  throwawayDevice,
  wordCount,
} from './check-summary-lib.mjs';

/** A draft every rule passes, in each language. The failing cases below change one thing in it. */
const PASSING = {
  en: 'I have been feeling low and worried for a while. My last two check-ins scored 12 and 9. I would like someone at the clinic to get in touch soon.',
  ar: 'أشعر بالتعب والضيق منذ فترة، وقد أجبت عن استبيانين قصيرين. كانت نتيجتي في الأول ١٢ وفي الثاني ٩. أرغب في أن يتواصل معي أحد من العيادة قريباً.',
};

/**
 * @param {'en' | 'ar'} locale
 * @param {{ text?: string, source?: string, elapsedMs?: number }} [change]
 * @returns {string[]} the names of the rules the draft fails
 */
function failures(locale, change = {}) {
  const draft = { source: change.source ?? 'ai', text: change.text ?? PASSING[locale] };
  return checkDraft({ locale, draft, elapsedMs: change.elapsedMs ?? 2500 }).map((failure) => failure.rule);
}

/** @param {number} n */
const words = (n) => `${Array.from({ length: n - 1 }, () => 'word').join(' ')} end.`;

test('a good English draft and a good Arabic draft pass every rule', () => {
  assert.deepEqual(failures('en'), []);
  assert.deepEqual(failures('ar'), []);
});

test('a template draft fails the source rule', () => {
  assert.deepEqual(failures('en', { source: 'template' }), ['source']);
});

test('a draft slower than the limit fails the time rule, and one at the limit passes', () => {
  assert.deepEqual(failures('en', { elapsedMs: DRAFT_TIME_LIMIT_MS + 1 }), ['time']);
  assert.deepEqual(failures('en', { elapsedMs: DRAFT_TIME_LIMIT_MS }), []);
});

test('a draft over the word limit fails the words rule, and one at the limit passes', () => {
  assert.equal(wordCount(words(DRAFT_WORD_LIMIT + 1)), DRAFT_WORD_LIMIT + 1);
  assert.deepEqual(failures('en', { text: words(DRAFT_WORD_LIMIT + 1) }), ['words']);
  assert.deepEqual(failures('en', { text: words(DRAFT_WORD_LIMIT) }), []);
});

test('a draft with no closing punctuation fails the ending rule, and each closing mark passes', () => {
  assert.deepEqual(failures('en', { text: 'I have been feeling low and I would like someone to' }), ['ending']);
  for (const mark of ['.', '!', '?', '؟', '。']) {
    assert.deepEqual(failures('en', { text: `I would like someone to get in touch${mark}` }), [], mark);
  }
  assert.deepEqual(failures('ar', { text: 'أرغب في أن يتواصل معي أحد من العيادة' }), ['ending']);
  assert.deepEqual(failures('ar', { text: 'هل يمكن أن يتواصل معي أحد من العيادة؟' }), []);
});

test('a draft holding the private-note marker fails the marker rule', () => {
  assert.deepEqual(failures('en', { text: `${PASSING.en} ${PRIVATE_MARKER}.` }), ['marker']);
});

test('a draft holding a private-note phrase fails the phrase rule, whatever its case', () => {
  assert.deepEqual(PRIVATE_PHRASES, ['long shifts', 'switch off']);
  assert.deepEqual(failures('en', { text: 'I have had Long Shifts lately and I would like someone to get in touch.' }), ['phrase']);
  assert.deepEqual(failures('en', { text: 'It is hard to SWITCH OFF at night and I would like someone to get in touch.' }), ['phrase']);
});

test('English asked for but Arabic letters present fails the language rule', () => {
  assert.deepEqual(failures('en', { text: `${PASSING.en} شكراً.` }), ['language']);
});

test('Arabic asked for but none written fails the language rule, and Arabic digits alone do not count as Arabic', () => {
  assert.deepEqual(failures('ar', { text: PASSING.en }), ['language']);
  assert.deepEqual(failures('ar', { text: '١٢ ٩ ٣.' }), ['language']);
});

test('each listed English term fails the term rule', () => {
  for (const term of LISTED_TERMS.en) {
    assert.deepEqual(failures('en', { text: `I would like help with ${term.toUpperCase()} please.` }), ['term'], term);
  }
});

test('each listed Arabic term fails the term rule', () => {
  for (const term of LISTED_TERMS.ar) {
    assert.deepEqual(failures('ar', { text: `أرغب في أن يتواصل معي أحد بشأن ${term} من العيادة.` }), ['term'], term);
  }
});

test('an English term does not fail an Arabic draft, nor an Arabic term an English one', () => {
  assert.deepEqual(failures('ar', { text: `${PASSING.ar} risk` }).includes('term'), false);
  assert.deepEqual(failures('en', { text: `${PASSING.en} خطر` }).includes('term'), false);
});

test('a draft that breaks two rules reports both', () => {
  assert.deepEqual(failures('en', { source: 'template', elapsedMs: DRAFT_TIME_LIMIT_MS + 1 }), ['source', 'time']);
});

test('the draft request ticks only ticket, scores and trajectory and carries an unticked note with the marker', () => {
  const request = draftRequest('ar', '00000000-0000-4000-8000-000000000000');
  assert.deepEqual(request.consented, CONSENTED_ELEMENTS);
  assert.equal(request.consented.includes('free_text'), false);
  assert.equal(request.useAi, true);
  assert.equal(request.locale, 'ar');
  assert.ok(request.content.free_text.includes(PRIVATE_MARKER));
  assert.ok(request.content.free_text.toLowerCase().includes('long shifts'));
  assert.ok(request.content.free_text.toLowerCase().includes('switch off'));
});

test('a throwaway device has a credential in the format the API reads and is different each time', () => {
  const first = throwawayDevice();
  assert.match(first.authorization, /^Bearer [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.authorization, throwawayDevice().authorization);
});

test('only a loopback host is accepted', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) assert.equal(nonLoopbackHost(host), null, host);
  for (const host of ['0.0.0.0', 'api.example.com', '10.0.0.5']) assert.match(nonLoopbackHost(host) ?? '', /not this machine/, host);
});

test('the template hint names the settings, never a value, and says why when the API did', () => {
  const plain = templateHint({ source: 'template', text: '' }).join('\n');
  for (const name of ['SUMMARY_LLM_ENABLED', 'SUMMARY_PROVIDER', 'ANTHROPIC_API_KEY', 'SUMMARY_FOUNDRY_API_KEY', 'SUMMARY_FOUNDRY_RESOURCE', 'SUMMARY_MODEL']) {
    assert.ok(plain.includes(name), name);
  }
  assert.ok(plain.includes('source is template'));
  assert.ok(plain.includes('logs no reason'));
  const capped = templateHint({ source: 'template', text: '', aiUnavailable: 'daily_cap' }).join('\n');
  assert.ok(capped.includes('SUMMARY_DAILY_LIMIT'));
  assert.equal(capped.includes('SUMMARY_PROVIDER'), false);
});
