# Outbound messages: the Notifier

Code in `apps/api/src/notifier` (`templates.ts`, `drivers.ts`), tests in `apps/api/test/notifier.test.ts`. **Nothing is sent.** Every outbound message goes through one `Notifier` and a mock driver records that one would have gone.

## Templates

Keyed, each in Arabic and English (`TEMPLATES`): `staff_sign_in` (a staff member's sign-in link), `clinic_link` (a facility's one-time link to one ticket) and `reminder_text` (the sample text reminder). The language is the recipient's (staff links use English, a person's reminder their registered language); anything that is not Arabic or English is served English.

No template carries clinical content. The person-facing one (`reminder_text`) holds none of the words the app's own reminder is banned from (score, band, instrument, condition, service, crisis, treatment and the rest, in both languages) and no digit; the two staff templates hold no score, band, instrument, condition or crisis wording. `notifier.test.ts` checks every template in both languages.

## Drivers

`NOTIFIER_DRIVER` (read strictly at start-up, like `DEMO_MODE`): unset or empty is `log`; `console` or `log` select a driver; any other value stops the API.

- `log` writes one structured record through the API's logger (the default, and what the end-to-end harness reads the sign-in link from).
- `console` prints one readable line on the process's output.

Both say they are mocks. A record holds the driver, `mock: true`, the template key, the language, the channel (`staff_link`, `clinic_link` or `sms`) and a **recipient reference**: a keyed hash of the recipient, cut to 12 hex digits, that cannot be turned back into it. For `reminder_text` that is all: **never the phone number and never the message text**. The staff sign-in link and the clinic link are the one thing kept on purpose: their record adds the link (and the staff address, or the facility and ticket code) and the expiry, with the same log messages as before ("staff sign-in link (logged, not sent)", "clinic link (logged, not sent)"), because the presenter copies the link from there.

`notifier.test.ts` also scans the API source for every line that can write a log (`log.*`, `console.*`, `process.stdout.write`) outside the notifier, lists each reviewed one, and fails for a new one or for one that names a phone, a body, a reminder or a ciphertext.

## The sample text reminder

`POST /me/reminder-phone/sample` (person access) hands a sample reminder for the number the person stored to the notifier, on their request (the Settings button "Show a sample text"). It answers `{ sample: true, nothingSent: true }`, 404 without a stored number and 502 if the notifier fails. It is not a schedule and changes none of the reminder rules: reminders are off by default, the number is optional, kept as ciphertext in `reminder_phones` and deleted by removing it, turning reminders off and Delete everything.
