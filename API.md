# Chat backend API

Base URL: `http://localhost:3001` locally (`WEB_ORIGIN` env var on the backend controls which
frontend origin CORS allows — set it to wherever your frontend runs, e.g.
`http://localhost:5173` or your deployed URL).

## Entry points → what to send

All three entry points hit the same backend, just with a different `entryPoint` string (and
`productCode` when it's already known):

| Entry point | `entryPoint` value | `productCode` | Can recommend products? |
|---|---|---|---|
| Sticky widget (every page) | `"sticky_widget"` | omit — not known yet | Yes |
| Product page button | `"product_page"` | the product's code, e.g. `"59405"` — you already know it from the page | Yes |
| Header → Support → Technical Support page | `"technical_support_page"` | omit | No — strictly troubleshooting, will decline/escalate a "help me choose" question here |

`entryPoint` **does** change bot behavior: on the sticky widget and product-page, the bot can
search the product catalog snapshot (see below) and suggest/recommend products, not just
troubleshoot. On the technical-support page it stays strictly troubleshooting-only by design.
Any other/unrecognised `entryPoint` value defaults to the strict (no-recommend) behavior.

### Product catalog

The bot can search a snapshot of ~2000 scraped products (name, category, finish, size,
features — **no price, no live stock**) when recommending. It's told to never state a price
and to phrase stock as "showed as in stock in our last catalog update, please confirm" rather
than a live fact. This is separate from the troubleshooting knowledge base and only used on
the two entry points marked above.

## 1. Send a message — `POST /chat/message`

**This is a streaming endpoint (Server-Sent Events / SSE), not a single JSON response.**

Request body:

```jsonc
{
  "sessionId": "uuid-or-omit-on-first-message",
  "message": "My lock 59405 battery drains fast",
  "entryPoint": "sticky_widget",
  "productCode": "59405", // optional, only when already known (product page)
  "imageUrl": "https://.../chat-uploads/2026-09-29/xxx.jpeg" // optional, see upload-image below
}
```

- `sessionId`: omit on the very first message of a conversation. The backend creates one and
  sends it back as the first event — store it and pass it on every subsequent message in that
  conversation.
- `message`: max 2000 chars, optional if `imageUrl` is set (a customer can send just a photo).
- `imageUrl`: the URL returned by `POST /chat/upload-image` (see below). The model can see and
  reason about the image (product identification, visible damage, etc).

Response: `Content-Type: text/event-stream`. Each event is one line `data: <json>\n\n`. Read the
response body as a stream and parse each `data:` line as JSON. Event shapes:

```ts
{ type: 'session', sessionId: string }               // always first
{ type: 'chunk', text: string }                       // 0+ times, the answer streaming in
{ type: 'done', needsEscalation: boolean, escalationSummary?: string, message?: string }
{ type: 'error', code: ChatErrorCode, message: string } // only if something broke server-side
```

```ts
type ChatErrorCode = 'RATE_LIMIT' | 'AUTH_ERROR' | 'UPSTREAM_ERROR' | 'UNKNOWN';
```

- Append every `chunk.text` to the message you're rendering, in order, to get the live-typing
  effect.
- On `done`:
  - `needsEscalation: false` → nothing else to do, the streamed chunks are the full answer.
  - `needsEscalation: true` → **no chunks were streamed for this turn** (the bot doesn't know
    the answer). Show `message` as the bot's reply (it's the "I don't have this, can I get your
    email" text) and present a form asking for the visitor's email — you'll need it for the next
    call.
  - `type: 'error'` → no `done` event follows this turn. `message` is already a
    reasonable thing to show as-is, but you can branch on `code` for a more specific UI:
    - `RATE_LIMIT` — we've hit the AI provider's usage/rate limit. Show something like "AI limit
      reached, try again shortly" (this is the one you specifically asked about).
    - `AUTH_ERROR` — the backend's API key is invalid/misconfigured. This is an operator problem,
      not something the visitor can fix — a generic "temporarily unavailable" is fine.
    - `UPSTREAM_ERROR` — the AI provider itself is down/degraded (5xx). Same treatment as
      RATE_LIMIT — transient, worth a retry.
    - `UNKNOWN` — anything else (network blip, a DB hiccup, etc). Generic error message.
  - **Partial answers:** if the model was already streaming chunks and then fails mid-way, you'll
    get some `chunk` events followed by an `error` (no `done`). Decide whether to keep the partial
    text visible with an error note appended, or discard it — the backend doesn't decide this for
    you.

`GET /chat/products` and `POST /chat/escalate` use the same `code`/`message` shape, but as a
plain JSON error body with HTTP status `503` (they're not streaming endpoints):

```json
{ "code": "UNKNOWN", "message": "Something went wrong on our end. Please try again." }
```

Minimal fetch-based reference implementation (adapt to your framework):

```js
const res = await fetch(`${API_URL}/chat/message`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId, message, entryPoint, productCode }),
});
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const parts = buffer.split('\n\n');
  buffer = parts.pop() ?? '';
  for (const part of parts) {
    if (!part.startsWith('data:')) continue;
    const event = JSON.parse(part.slice(5).trim());
    // handle event.type: 'session' | 'chunk' | 'done' | 'error'
  }
}
```

## 2. Upload a photo — `POST /chat/upload-image`

Call this first when the customer attaches a photo, get back a URL, then include that URL as
`imageUrl` in the following `POST /chat/message` call.

Request: `multipart/form-data` with a single field `file`.

```js
const formData = new FormData();
formData.append('file', fileFromInput); // a File/Blob from an <input type="file">
const res = await fetch(`${API_URL}/chat/upload-image`, { method: 'POST', body: formData });
const { url } = await res.json();
```

- Accepted types: `image/jpeg`, `image/png`, `image/webp`, `image/heic`.
- Max size: 8MB.
- Response: `201` with `{ "url": string }` — a public URL (stored in Supabase Storage). `400` if
  the file is missing/wrong type/too large, `503` with the usual `{code, message}` shape if
  storage itself is unavailable.
- The photo is also attached to the escalation email transcript automatically if the
  conversation later escalates to a human, so nothing extra is needed for that.

## 3. Product code list (for a model dropdown) — `GET /chat/products`

Returns a flat array of known product codes, for an optional "select your model" dropdown next
to the free-text input:

```json
["9405", "9409", "49421", "49429", "59143", "59400", "59405", "59407", "59409", "59410", "59413", "89143", "89413"]
```

Not required — customers can also just type the code naturally in their message (the backend
detects it either way). The dropdown is a nice-to-have shortcut.

## 4. Escalate to a human — `POST /chat/escalate`

Call this once the visitor submits their email after a `needsEscalation: true` turn.

Request body:

```jsonc
{
  "sessionId": "same session id from the conversation",
  "customerEmail": "customer@example.com",
  "productCode": "59405", // optional
  "issueDescription": "The one-sentence summary the bot gave you as `escalationSummary`"
}
```

Response: `200` with the created escalation row, or a validation error (`400`) if the email is
malformed or fields are missing. There's no separate confirmation event to wait for — treat a
`200` as success and show a "thanks, our team will follow up" message.

Note: right now `RESEND_API_KEY` / `ESCALATION_TO_EMAIL` aren't set, so escalations save to the
database but no email actually goes out yet — that's independent of the frontend integration.

## Things that are NOT wired up yet (don't build UI expecting these)

- **Stock / live pricing** — no live data source connected. Any question about stock/price will
  currently either get a generic non-answer or escalate.
- **Multi-photo per message** — one `imageUrl` per message. If a customer needs to show two
  things (e.g. their broken lock and the door), send two separate messages.
