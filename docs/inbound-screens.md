# Handing over a positive screen (for a front door)

A service that screens people (TAMM, a primary health centre, a school programme) can hand a positive screen to
Mawsool. It never creates a ticket: it creates an **invite**, and the person claims it on their own phone, then chooses
what to share. Nothing about the person is sent, only that a screen was positive.

## The request

`POST /inbound/screens`, JSON body, exactly these fields (any other is refused):

```json
{ "result": "positive", "screenedAt": "2026-11-01T08:00:00+04:00", "locale": "ar" }
```

`locale` (`ar` or `en`) is the language of the claim link.

## Signing

Each front door has its own key (`INBOUND_KEY_TAMM`, `INBOUND_KEY_PHC`, `INBOUND_KEY_SCHOOL` on the API; at least 32
characters). Four headers go with the body:

| Header                  | Value                                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| `x-mawsool-source`      | `tamm`, `phc` or `school`                                             |
| `x-mawsool-timestamp`   | seconds since the epoch, ten digits                                   |
| `x-mawsool-nonce`       | 16 to 64 characters from `A-Z a-z 0-9 _ -`, new for every request     |
| `x-mawsool-signature`   | lowercase hex of HMAC-SHA256, with the key, of the four lines below   |

The signed text is the source, the timestamp, the nonce and the exact body bytes, one per line:

```
tamm
1793501234
q3vK-8_Zr0T5mP2xLw
{"result":"positive","screenedAt":"2026-11-01T08:00:00+04:00","locale":"ar"}
```

The timestamp must be within 300 seconds of the API's clock, and a nonce is accepted once per source. The reference
implementation is `apps/api/src/inbound/signing.ts`; `apps/person/e2e/staff-helpers.ts` signs the same way, written
separately from the documented scheme.

## The answer

`201`:

```json
{ "inviteId": "…", "code": "ABCD-EFGH", "claimUrl": "https://…/ar/claim/?code=ABCD-EFGH", "expiresAt": "…" }
```

The code is shown once (only its hash is kept) and lasts 30 days. Show the person `claimUrl`, or the code to type. A
request with a missing or wrong signature, a time outside the window, or a source with no key gets the same `401`; a
nonce that was used before gets `401` with `error: "replayed"`. Neither leaves an invite behind.

## What the person sees

The link opens the claim screen with the code filled in; nothing is claimed until they press the button. A claimed
invite's source goes onto the ticket they later send, and the clinic sees where it came from.
`/<locale>/tamm/?code=…` in the person app is a labelled mock of the page TAMM would show before that link.
