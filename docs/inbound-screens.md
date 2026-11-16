# Handing over a positive screen (for a front door)

A service that screens people (TAMM, a primary health centre, a school programme) can hand a positive screen to
Mawsool. It never creates a ticket: it creates an **invite**, and the person claims it on their own phone, then chooses
what to share. Nothing about the person is sent, only that a screen was positive.

![A sequence between a front door, the Ticket API and the person's phone: the front door sends a signed positive screen, the API checks the key, the time window, the signature and the nonce, answers with an invite and a claim code, the front door shows the code to the person, who claims it and later sends a ticket with consent](images/inbound-screen.svg)

Source: drawn by hand from this page and `apps/api/src/inbound/` at `a40b68d`. Steps 1 to 3 are the request, the
signing and the answer below; 4 to 6 are under "What the person sees".

**What this tells us**
- The front door's whole part is steps 1 to 4: it never sees what the person later shares, and cannot make a ticket for them.
- Step 2 either stores the invite and spends the nonce together, or does neither, which is what makes a retry safe.

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
request with a missing or wrong signature, a time outside the window, or a source with no key gets the same `401`;
neither leaves an invite behind.

### When the answer is lost or is an error

The nonce is spent and the invite stored in one step, so they stand or fall together.

- **A timeout, a dropped connection or a `5xx`:** you do not know whether the invite was made. Sign the request again
  with a **fresh nonce** (and a fresh timestamp) and send it. If the first one did reach the API, this makes a second
  invite and a second code; the first code stays valid but nobody has it, so it is harmless and expires in 30 days. Show the
  person the code from the answer you receive.
- **`401` with `error: "replayed"`:** that nonce was already used by a request that was processed, so do not send it
  again. It does **not** prove an invite exists that you can use: if you never saw the `201`, you do not have the code, and
  the code is never shown twice. Re-sign with a fresh nonce.
- **`400`:** the body was refused and nothing was stored, nonce included, so a corrected body can be sent with the same
  nonce.

## What the person sees

The link opens the claim screen with the code filled in; nothing is claimed until they press the button. A claimed
invite's source goes onto the ticket they later send, and the clinic sees where it came from.
`/<locale>/tamm/?code=…` in the person app is a labelled mock of the page TAMM would show before that link.
