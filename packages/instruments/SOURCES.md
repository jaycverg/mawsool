# Instrument wording sources

Fetched 2026-11-01. Wording is copied from the published sources below and is never machine-translated.

**`verified` means published validated wording**: the text is copied from a published source that was obtained,
and a published validation study of that same instrument and language form is cited in the row. Anything less is
`unverified`, which is an accepted outcome for Phase 1 and shows a visible label wherever the wording appears.
Text that is only copied from a source, with no validation evidence for that form, stays `unverified`.

Validation studies were checked at abstract level through PubMed (title, authors, journal, year and the abstract's
conclusion); the papers were not read in full.

The table is kept in step with `src/sources.ts` and the wording data by `test/wording.test.ts`.

## Status by instrument and locale

| Source id  | Instrument | Locale | Status     | Basis for the status |
| ---------- | ---------- | ------ | ---------- | -------------------- |
| `phq9-en`  | PHQ-9      | en     | verified   | Original English form from the developers' distributor; validation: [Kroenke, Spitzer and Williams, J Gen Intern Med 2001](https://pubmed.ncbi.nlm.nih.gov/11556941/), which concludes the PHQ-9 is a reliable and valid measure of depression severity. |
| `gad7-en`  | GAD-7      | en     | verified   | Original English form from the developers' distributor; validation: [Spitzer, Kroenke, Williams and Löwe, Arch Intern Med 2006](https://pubmed.ncbi.nlm.nih.gov/16717171/), which concludes the GAD-7 is a valid tool for screening for GAD and assessing its severity. |
| `who5-en`  | WHO-5      | en     | verified   | Original English form published by WHO; validation: [Topp, Østergaard, Søndergaard and Bech, Psychother Psychosom 2015](https://pubmed.ncbi.nlm.nih.gov/25831962/), a systematic review concluding the WHO-5 has adequate validity as a screening tool for depression and as an outcome measure. |
| `cssrs-en` | C-SSRS     | en     | unverified | This is the patient-facing self-report screener form. A validation study of the C-SSRS exists (Posner et al., Am J Psychiatry 2011;168:1266-1277, found by search, not read), but that it covers this form was not established. |
| `phq9-ar`  | PHQ-9      | ar     | unverified | Tunisian-Arabic edition. The form prints no validation statement and no validation study of this Arabic text was obtained. The text is kept. |
| `gad7-ar`  | GAD-7      | ar     | unverified | Tunisian-Arabic edition. The form prints no validation statement and no validation study of this Arabic text was obtained. The text is kept. |
| `who5-ar`  | WHO-5      | ar     | unverified | Hand transcription of an image-only 1999 scan, and no validation study of this Arabic text was obtained. |
| `cssrs-ar` | C-SSRS     | ar     | unverified | No Arabic text was obtained. Item text is `null`. |

## Where each text came from

| Source id  | Published source | How it was obtained | Licence or permission | Caveat |
| ---------- | ---------------- | ------------------- | --------------------- | ------ |
| `phq9-en`  | [PHQ Screeners, PHQ-9 English](https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/PHQ-9_English.pdf) | Text extracted locally from the PDF and compared with the item strings; checked against the render. | Printed on the form: no permission required to reproduce, translate, display or distribute. | No version or year printed on the form. |
| `gad7-en`  | [PHQ Screeners, GAD-7 English](https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/GAD-7_English.pdf) | Text extracted locally from the PDF and compared with the item strings. | Same statement as PHQ-9. | A third-party "adapted" copy online words items 1 and 6 differently; this is the distributor copy, not that one. |
| `who5-en`  | [WHO, WHO-5 English original](https://cdn.who.int/media/docs/default-source/mental-health/who-5_english-original4da539d6ed4b49389e3afe47cda2326a.pdf) | Text extracted locally (the PDF text layer is doubled); compared with the render. | CC BY-NC-SA 3.0 IGO (WHO 2024). NonCommercial and ShareAlike terms need a legal read before any use beyond a demo. | None beyond the licence. |
| `cssrs-en` | [Columbia Lighthouse Project, Screener Self-Report Recent](https://cssrs.columbia.edu/wp-content/uploads/C-SSRS-Screener-Self-Report-Recent-2026.pdf) | Text extracted locally from the PDF and compared with the item strings. | No licence text on the form. Site footer: all rights reserved; protocol described as free for community and healthcare use. Terms for use in this app not established. | Self-report form, time frame "in the past month". |
| `phq9-ar`  | [PHQ Screeners, PHQ-9 "Arabic for Tunisia"](https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/PHQ9_Arabic%20for%20Tunisia.pdf) | Text extracted locally; Arabic presentation forms folded with Unicode NFKC and the PDF text layer's kaf glyph mapped back to kaf; compared with the render by two readers. | Printed in Arabic on the form: no permission required to reproduce, translate, display or distribute. | Suitability for UAE users not established. The stem asks how much the person suffered, not how often. |
| `gad7-ar`  | [PHQ Screeners, GAD-7 "Arabic for Tunisia"](https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/GAD7_Arabic%20for%20Tunisia.pdf) | Same method as `phq9-ar`. | Same statement as `phq9-ar`. | Suitability for UAE users not established. |
| `who5-ar`  | [WHO, WHO-5 Arabic (1999 scan)](https://cdn.who.int/media/docs/default-source/mental-health/five-well-being-index-%28who-5%29/who-5_arabic.pdf) | Image-only scan, no text layer, no Arabic OCR available. Transcribed by eye from the render by two readers who agreed. Not machine-checked. | Not established for the scan; the English original is CC BY-NC-SA 3.0 IGO. | Check every string against page 3 of the PDF before relying on it. |
| `cssrs-ar` | None obtained | The publisher lists Arabic translations of the full scale but gave no download link, and its screener translations folder could not be opened. | Not established. | The publisher says a translation validated for one country should not be used where it has not been validated. |

## Open items for the team

- Obtain the Arabic C-SSRS screener from the Columbia Lighthouse Project, and confirm its terms for use in this app.
- Obtain an Arabic PHQ-9 and GAD-7 with a published validation for Gulf populations, or accept the Tunisian editions with their label.
- Check the `who5-ar` strings against the WHO scan, or obtain a validated Arabic text.
- Establish whether a validation study covers the C-SSRS self-report screener form used here.
- Read the WHO-5 CC BY-NC-SA terms before any use beyond a demo.
