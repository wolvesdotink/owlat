# Public token endpoint module — one shell for every public, token-keyed httpAction

**Status:** proposed

## Context

The codebase has one cross-cutting concern that crosses six files but
sits behind no interface: how a public, token-keyed, no-session
`httpAction` parses its URL, runs its rate-limit gate, handles CORS,
parses its body (when applicable), and shapes its response. Every
public-token endpoint open-codes the same shell.

`auth/apiAuth.ts:createAuthenticatedHandler` is the sibling factory
for the *API-key* posture — one file, used by `topics/apiHttp.ts`,
owns CORS + auth + rate-limit + error envelope. The public-token
posture has no equivalent. Nine endpoints across six files
re-implement the surface from scratch.

### Caller landscape — public, token-keyed `httpAction`s

| Endpoint | File:line | Token from | Rate-limit | CORS | Body | Error envelope | Notes |
|---|---|---|---|---|---|---|---|
| `handleOneClickUnsubscribe` | `delivery/unsubscribeHttp.ts:10-88` | `pathParts[2]` | `subscriptionManagement` | none | none | `{ error: 'msg' }` | RFC 8058 |
| `verifyUnsubscribeToken` | `delivery/unsubscribeHttp.ts:92-172` | `pathParts[3]` | `subscriptionManagement` | `GET, OPTIONS` | none | `{ valid: false, error, reason }` | 200 on invalid |
| `verifyPreferenceToken` | `delivery/preferencesHttp.ts:10-90` | `pathParts[3]` | `subscriptionManagement` | `GET, OPTIONS` | none | `{ valid: false, error, reason }` | 200 on invalid |
| `updatePreferences` | `delivery/preferencesHttp.ts:93-223` | `pathParts[3]` | `subscriptionManagement` | `POST, OPTIONS` | JSON | `{ success: false, error, reason }` | 400 on invalid |
| `verifyContactDoiToken` | `topics/doiHttp.ts:29-91` | `?token=` | `doiConfirmation` | `GET, POST, OPTIONS` | none | `{ error: { message, code } }` | querystring |
| `confirmContactDoi` | `topics/doiHttp.ts:97-158` | `?token=` | `doiConfirmation` | `GET, POST, OPTIONS` | none | `{ error: { message, code } }` | querystring |
| `submitForm` | `forms/apiHttp.ts:125-241` | `pathParts[-1]` | `formSubmission` | `POST, OPTIONS` | JSON / urlencoded / multipart | `{ error: { message, code } }` | redirect on success |
| `getShareLink` | `shareLinkHttp.ts:11-85` | `pathParts[2]` | `subscriptionManagement` | `GET, OPTIONS` | none | `{ error: 'msg' }` | — |
| `getCampaignArchive` | `campaigns/archiveHttp.ts:11-77` | `pathParts[2]` | `subscriptionManagement` | `GET, OPTIONS` | none | `{ error: 'msg' }` | — |

Nine endpoints. Six files. Four error envelope flavours. Four
rate-limit kinds. Three token-location patterns. Two body-parsing
shapes (none, JSON, multipart). Every variation independently
maintained.

### 1. Path-positional indexing is silently fragile

Every site extracts its token via positional path slicing
(`pathParts[2]`, `pathParts[3]`, `pathParts[pathParts.length - 1]`).
If a route prefix moves (`/unsub/...` → `/u/...`, or a new mount
point), the index shifts and every shell breaks at runtime, not at
type-check. The bug surface is invisible to the compiler.

The form path is the worst case — `pathParts[pathParts.length - 1]`
also skips `decodeURIComponent`, so a token with a URL-encoded
character silently fails to match the database. The other sites
remember to decode; the form path's convention drift is undetected.

### 2. Error envelope drift across four flavours

| Envelope | Sites |
|---|---|
| `{ error: 'msg' }` | unsub one-click, share, archive |
| `{ valid: false, error, reason }` | unsub verify, prefs verify |
| `{ success: false, error, reason }` | prefs update |
| `{ error: { message, code } }` | DOI verify/confirm, form submit, API-key endpoints |

Frontend callers in `apps/web` handle three of these flavours
independently. Adding a fifth shape (any new endpoint) is one
copy-paste away. The drift exists because the chokepoint exists in
exactly one auth posture (`auth/apiAuth.ts` ships `errorResponse`),
and the public-token posture has no chokepoint.

### 3. CORS preflight drift

Each shell hand-wires its allowed methods. Most use the shared
`publicCorsHeaders(...)` helper; one (`topics/apiHttp.ts`'s collection
handler) inlines the headers directly. The form path computes
`corsHeaders` once at module top; the other paths compute it per-call.
None of this matters for correctness today; all of it is drift surface.

### 4. "200 on invalid token" hides what verify endpoints actually return

`verifyUnsubscribeToken` and `verifyPreferenceToken` return HTTP 200
with `{ valid: false, error }` so the frontend can render a friendly
"this link expired" page. That's the right product behaviour wrapped
in the wrong protocol — a successful verification request that
discovers an expired token is not an HTTP error, it's a result. The
convention is undocumented and drifts: `updatePreferences` returns
the *same* `{ valid: false }`-style payload but with status 400, and
`confirmContactDoi` returns it with status 400 under yet another
envelope shape.

### 5. Rate-limit-kind by convention only

Each site picks a `PublicRateLimitType` literal at call time. There
is no type-level link between "this endpoint" and "this rate-limit
kind"; the type is a parameter to a generic mutation. A new endpoint
forgetting to call `checkPublicRateLimit` at all would type-check
cleanly. Today's safety is convention-by-copy.

### 6. Tracking pixel and click redirect are different enough to keep open-coded

`delivery/trackingHttp.ts` (170 LOC) defines `trackOpen` and
`trackClick`. Both have **graceful-on-rate-limit** semantics: always
respond with the pixel (or always redirect), skip the recording when
rate-limited. The response body is binary (1×1 GIF) or a 302
redirect, not JSON. They have no CORS — they are `<img>` and `<a>`
targets, not browser-fetch endpoints. Three load-bearing differences
that don't generalise across the other nine sites.

This ADR **does not deepen tracking**. Folding it in would force a
`fallbackResponse` knob, a `responseShape: 'json' | 'binary' |
'redirect'` knob, and a `corsRequired: boolean` knob — three
parameters that pay off in exactly two places. Tracking stays
open-coded.

### Shared framing

Per LANGUAGE.md's deletion test: deleting any one of the nine
public-token shells today does not concentrate complexity — each
shell is independent. But *constructing* the shell at a shared
location reveals that all nine want the same interface (path
extract, rate-limit gate, CORS, error envelope, body parse). The
seam is real; it has never been deployed.

The interface is the test surface: pre-lift, "rate-limit short-
circuit returns the right envelope" / "CORS preflight returns 204
with the right methods" / "token decode handles URL-encoded
characters" can only be tested by spinning up each `httpAction`
independently. None of the nine sites have such tests. Post-lift,
the shell has one set of tests covering all of those concerns; the
per-endpoint tests focus on handler logic against a typed `{ token,
body }` input.

Confidence: high. Pure consolidation. No new behaviour at the
shell layer (modulo the locked error envelope, which is an
intentional break — see below). No schema change. Six files
shrink; one new factory file lands; one new shared-helper file
lands.

## Decision

Introduce two new files, lock the error envelope across all public
token endpoints, migrate the nine endpoints to the factory, and
update three frontend callers in the same commit for the locked
envelope.

### New module: Public token endpoint (module)

```
convex/lib/publicTokenEndpoint.ts
```

Single entry point. Owns the shell shape for public, token-keyed
`httpAction`s. Mirrors the **API-key endpoint** factory
(`createAuthenticatedHandler` at `convex/auth/apiAuth.ts`) — sibling
factories, one per auth posture, both consuming the shared response
helpers at `convex/lib/httpResponse.ts`.

```ts
// convex/lib/publicTokenEndpoint.ts (sketch)
import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import type { PublicRateLimitType } from '../publicRateLimit';
import { getClientIp, rateLimitedResponse } from '../publicRateLimit';
import {
  jsonResponse,
  errorResponse,
  publicCorsHeaders,
  type CorsMethodsHeader,
} from './httpResponse';
import { logError } from './runtimeLog';

type ResultAction<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string; status?: number };

type ResultOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string };

type BodyParser = 'none' | 'json' | 'formData';

export type ParsedBody<P extends BodyParser> =
  P extends 'json' ? unknown :
  P extends 'formData' ? Record<string, string> :
  undefined;

interface EndpointConfig<P extends BodyParser, R extends 'action' | 'outcome'> {
  path: string;                          // e.g. '/unsub/:token' or '/confirm/doi'
  method: 'GET' | 'POST';
  rateLimit: PublicRateLimitType;
  cors?: CorsMethodsHeader | false;      // 'GET, OPTIONS' | 'POST, OPTIONS' | ... | false
  body?: P;                              // defaults to 'none'
  resultMode: R;
}

interface HandlerCtx {
  runQuery: (...args: unknown[]) => Promise<unknown>;
  runMutation: (...args: unknown[]) => Promise<unknown>;
  runAction: (...args: unknown[]) => Promise<unknown>;
}

interface HandlerArgs<P extends BodyParser> {
  token: string;
  body: ParsedBody<P>;
  request: Request;
}

export function publicTokenEndpoint<
  P extends BodyParser = 'none',
  R extends 'action' | 'outcome' = 'action',
  T = unknown,
>(
  config: EndpointConfig<P, R>,
  handler: (
    ctx: HandlerCtx,
    args: HandlerArgs<P>,
  ) => Promise<
    R extends 'action' ? ResultAction<T> : ResultOutcome<T>
  >,
) {
  const matcher = compilePath(config.path);   // ~20 LOC in-module, no dep
  const corsHeaders =
    config.cors === false ? null : publicCorsHeaders(config.cors ?? 'GET, OPTIONS');

  return httpAction(async (ctx, request) => {
    // 1. CORS preflight
    if (corsHeaders && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 2. Method gate
    if (request.method !== config.method) {
      return errorResponse('Method not allowed', 405, 'method_not_allowed', corsHeaders);
    }

    // 3. Rate-limit gate
    const ip = getClientIp(request);
    const { ok, retryAfter } = await ctx.runMutation(
      internal.publicRateLimit.checkPublicRateLimit,
      { limitType: config.rateLimit, key: ip },
    );
    if (!ok) {
      return rateLimitedResponse(retryAfter, { corsHeaders: corsHeaders ?? undefined });
    }

    // 4. Token extract — named segment or ?token=
    const url = new URL(request.url);
    const pathMatch = matcher(url.pathname);
    const tokenRaw =
      pathMatch?.token ?? url.searchParams.get('token') ?? null;
    if (!tokenRaw) {
      return errorResponse('Missing token', 400, 'missing_token', corsHeaders);
    }
    const token = decodeURIComponent(tokenRaw);

    // 5. Body parse
    let body: ParsedBody<P>;
    try {
      body = (await parseBody(request, config.body ?? 'none')) as ParsedBody<P>;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid body';
      return errorResponse(message, 400, 'invalid_body', corsHeaders);
    }

    // 6. Handler
    let result: ResultAction<T> | ResultOutcome<T>;
    try {
      result = await handler(ctx, { token, body, request });
    } catch (error) {
      logError(`[${config.path}] handler threw:`, error);
      return errorResponse('Internal error', 500, 'internal_error', corsHeaders);
    }

    // 7. Map result by mode
    if (config.resultMode === 'outcome') {
      // Always 200 (200 OK on a successful query that returns "invalid token")
      return jsonResponse(result, 200, corsHeaders);
    }
    if (result.ok) {
      return jsonResponse({ ok: true, data: result.data }, 200, corsHeaders);
    }
    const status = ('status' in result && result.status) || 400;
    return errorResponse(result.reason, status, result.reason, corsHeaders);
  });
}
```

The path matcher and body parser are inlined into the same file
(~30 LOC each) — the file lands at ~250 LOC including the typed
signature dance. No external dependency for path matching.

### Shared module: `convex/lib/httpResponse.ts`

Pulls `jsonResponse`, `errorResponse`, and CORS helpers out of
`auth/apiAuth.ts` and `lib/cors.ts` into one file consumed by both
factories. `auth/apiAuth.ts:createAuthenticatedHandler` keeps its
own auth-specific surface but stops re-defining response shapes.

```ts
// convex/lib/httpResponse.ts (sketch)
import { publicCorsHeaders as basePublicCorsHeaders } from './cors';

export type CorsMethodsHeader =
  | 'GET, OPTIONS'
  | 'POST, OPTIONS'
  | 'GET, POST, OPTIONS'
  | 'GET, POST, DELETE, OPTIONS';

export function publicCorsHeaders(methods: CorsMethodsHeader) {
  return basePublicCorsHeaders(methods);
}

export function jsonResponse(
  data: unknown,
  status = 200,
  corsHeaders: Record<string, string> | null = null,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(corsHeaders ?? {}),
    },
  });
}

export function errorResponse(
  message: string,
  status: number,
  code: string,
  corsHeaders: Record<string, string> | null = null,
): Response {
  return jsonResponse(
    { error: { message, code } },
    status,
    corsHeaders,
  );
}
```

### Locked error envelope: `{ error: { message, code } }`

Pre-deepening, four envelope flavours coexist. Post-deepening, the
shell emits exactly one shape on `resultMode: 'action'` 4xx:

```json
{ "error": { "message": "Token expired", "code": "token_expired" } }
```

And exactly one shape on `resultMode: 'outcome'` 200:

```json
{ "ok": false, "reason": "token_expired" }
// or
{ "ok": true, "data": { ... } }
```

This is a **wire contract change for three sites**:

| Site | Pre-deepening | Post-deepening | Caller migration |
|---|---|---|---|
| `unsubscribeHttp.handleOneClickUnsubscribe` | `{ error: 'msg' }` | `{ error: { message, code } }` | RFC 8058 client (mail clients) ignore the body; no caller breaks |
| `shareLinkHttp.getShareLink` | `{ error: 'msg' }` | `{ error: { message, code } }` | `apps/web` share-link error path |
| `archiveHttp.getCampaignArchive` | `{ error: 'msg' }` | `{ error: { message, code } }` | `apps/web` archive error path |
| `unsubscribeHttp.verifyUnsubscribeToken` | `{ valid: false, error, reason }` | `{ ok: false, reason }` (outcome mode, 200) | `apps/web` unsubscribe page |
| `preferencesHttp.verifyPreferenceToken` | `{ valid: false, error, reason }` | `{ ok: false, reason }` (outcome mode, 200) | `apps/web` preferences page |
| `preferencesHttp.updatePreferences` | `{ success: false, error, reason }` | `{ error: { message, code } }` (action mode, 4xx) | `apps/web` preferences update |
| `forms/apiHttp.submitForm` | `{ error: { message, code } }` | unchanged | — |
| `topics/doiHttp.verify/confirm` | `{ error: { message, code } }` | unchanged | — |

Frontend updates land in the same PR. The migration is mechanical —
a handful of lines per page, mostly renaming `valid` to `ok` and
unwrapping `error.message` instead of `error`.

### Path matcher

In-tree, no dependency. Supports literal segments and `:name`
parameter segments only — no regex per segment, no optional
parameters, no wildcards. Twenty lines:

```ts
function compilePath(pattern: string) {
  const segments = pattern.split('/').filter(Boolean);
  return (pathname: string): Record<string, string> | null => {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length !== segments.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const part = parts[i]!;
      if (seg.startsWith(':')) {
        params[seg.slice(1)] = part;
      } else if (seg !== part) {
        return null;
      }
    }
    return params;
  };
}
```

For endpoints with token in `?token=` (DOI verify/confirm), the
`path` is the literal route (`/confirm/doi`, `/confirm/doi/verify`)
and the shell falls back to `url.searchParams.get('token')` when no
`:token` segment is present.

### Caller migration

| File | Pre-deepening | Post-deepening |
|---|---|---|
| `convex/delivery/unsubscribeHttp.ts` | 172 LOC, 2 open-coded httpActions | ~40 LOC, 2 `publicTokenEndpoint` declarations |
| `convex/delivery/preferencesHttp.ts` | 223 LOC, 2 open-coded httpActions | ~60 LOC, 2 declarations |
| `convex/topics/doiHttp.ts` | 158 LOC, 2 open-coded httpActions | ~40 LOC, 2 declarations |
| `convex/forms/apiHttp.ts` | 241 LOC (submit) + 50 LOC (multipart `parseFormData`) | ~30 LOC declaration + the multipart parser stays local (still the only site) |
| `convex/shareLinkHttp.ts` | 85 LOC, 1 open-coded httpAction | ~20 LOC, 1 declaration |
| `convex/campaigns/archiveHttp.ts` | 77 LOC, 1 open-coded httpAction | ~20 LOC, 1 declaration |

Total: ~956 LOC of shell across 6 files becomes ~210 LOC of
declarations + 1 new ~250 LOC factory + 1 new ~80 LOC
`httpResponse.ts`. Net production LOC: roughly halved (~956 → ~540).

`forms/apiHttp.ts`'s `parseFormData` (multipart support) stays local
to the file. It's the only multipart caller; lifting it would add a
fourth `BodyParser` variant (`'formData' | 'multipart'`) for one
site. The form submission declaration sets `body: 'formData'` and
the shell dispatches to the form file's local helper through a
small extension point — or simpler: the form's `submitForm` keeps
its `parseFormData` inline and passes `body: 'none'` to the shell,
parsing the multipart body itself in the handler. Decided at
execution time; the ADR doesn't pre-commit.

### Replaces

| File:line | Pre-deepening | Post-deepening |
|---|---|---|
| `delivery/unsubscribeHttp.ts:10-88` | One-click unsubscribe shell | `publicTokenEndpoint({ path: '/unsub/:token', method: 'POST', rateLimit: 'subscriptionManagement', cors: false, resultMode: 'action' }, ...)` |
| `delivery/unsubscribeHttp.ts:92-172` | Verify shell | `publicTokenEndpoint({ path: '/unsub/verify/:token', method: 'GET', rateLimit: 'subscriptionManagement', cors: 'GET, OPTIONS', resultMode: 'outcome' }, ...)` |
| `delivery/preferencesHttp.ts:10-90` | Verify shell | `publicTokenEndpoint({ path: '/prefs/verify/:token', method: 'GET', rateLimit: 'subscriptionManagement', cors: 'GET, OPTIONS', resultMode: 'outcome' }, ...)` |
| `delivery/preferencesHttp.ts:93-223` | Update shell | `publicTokenEndpoint({ path: '/prefs/update/:token', method: 'POST', rateLimit: 'subscriptionManagement', cors: 'POST, OPTIONS', body: 'json', resultMode: 'action' }, ...)` |
| `topics/doiHttp.ts:29-91` | DOI verify (querystring) | `publicTokenEndpoint({ path: '/confirm/doi/verify', method: 'GET', rateLimit: 'doiConfirmation', cors: 'GET, POST, OPTIONS', resultMode: 'outcome' }, ...)` |
| `topics/doiHttp.ts:97-158` | DOI confirm (querystring) | `publicTokenEndpoint({ path: '/confirm/doi', method: 'POST', rateLimit: 'doiConfirmation', cors: 'GET, POST, OPTIONS', resultMode: 'action' }, ...)` |
| `forms/apiHttp.ts:125-241` | Form submit | `publicTokenEndpoint({ path: '/forms/:token', method: 'POST', rateLimit: 'formSubmission', cors: 'POST, OPTIONS', body: 'formData', resultMode: 'action' }, ...)` (the `:token` parameter happens to be `formEndpointId`, named `:token` only for shell consistency — or rename the parameter to `:formId` if the shell supports custom param names; decided at execution time) |
| `shareLinkHttp.ts:11-85` | Share preview | `publicTokenEndpoint({ path: '/share/:token', method: 'GET', rateLimit: 'subscriptionManagement', cors: 'GET, OPTIONS', resultMode: 'action' }, ...)` |
| `campaigns/archiveHttp.ts:11-77` | Archive | `publicTokenEndpoint({ path: '/archive/:token', method: 'GET', rateLimit: 'subscriptionManagement', cors: 'GET, OPTIONS', resultMode: 'action' }, ...)` |

`auth/apiAuth.ts:jsonResponse` / `errorResponse` move to
`lib/httpResponse.ts`. `auth/apiAuth.ts` keeps `createAuthenticatedHandler`
unchanged and re-exports the response helpers from the new shared
location.

### Closes drift bugs

1. **Path-positional indexing brittleness** — closed by the path
   matcher's named segments. Route prefix changes become declaration
   edits, caught at the call site.
2. **Form path missing `decodeURIComponent`** — closed by the shell
   decoding uniformly.
3. **Error envelope drift across four flavours** — closed by the
   locked envelope. Frontend migrates to the single shape.
4. **CORS preflight drift** — closed by the shell's uniform
   `OPTIONS` handler.
5. **"200 on invalid token" implicit convention** — closed by the
   explicit `resultMode: 'outcome'` discriminator. Verify endpoints
   declare their semantics; the shell honours them.
6. **Rate-limit kind by convention** — closed by the typed
   `rateLimit` parameter. Forgetting to call `checkPublicRateLimit`
   is no longer possible; the shell calls it once per declaration.
7. **500-on-throw inconsistency** — closed by the shell's uniform
   `try/catch` and `logError` call.

### Tests

Three new test surfaces:

1. **Shell shape tests** at
   `convex/lib/__tests__/publicTokenEndpoint.test.ts`. One file
   covering: path matcher (literal segments, named segments,
   mismatched arity, URL-encoded token), CORS preflight (returns 204
   with the right methods header), method gate (returns 405 for
   wrong method), rate-limit short-circuit (returns 429 with
   `Retry-After`), token extract from path vs querystring, body
   parse failure (returns 400 with locked envelope), handler-throw
   handling (returns 500 with locked envelope), action-mode result
   mapping (`{ ok: true }` → 200 with `data`, `{ ok: false }` →
   4xx with `error.{message,code}`), outcome-mode result mapping
   (both `ok: true` and `ok: false` return 200, body discriminates).
   Pure unit tests against a mock `httpAction` runtime.
2. **`httpResponse` tests** at
   `convex/lib/__tests__/httpResponse.test.ts`. Two cases per helper
   (`jsonResponse`, `errorResponse`): with CORS headers, without.
3. **No per-endpoint shell tests needed**. Each endpoint's existing
   integration tests (where they exist) continue to assert on the
   wire contract; the shell is exercised by them transitively.
   Where integration tests don't exist (the bulk of the public-token
   sites), the handler is now small enough to unit-test directly
   against a typed `{ token, body }` input.

### Out of scope for this ADR

- **Tracking pixel + click**. `delivery/trackingHttp.ts` stays
  open-coded. Graceful-on-rate-limit semantics, binary / redirect
  response shape, no CORS — three load-bearing differences that
  don't generalise to the JSON-token-keyed sites. A future ADR may
  introduce a separate `publicTrackingEndpoint` factory if a third
  graceful endpoint appears.
- **API-key endpoint deepening**. `createAuthenticatedHandler` is
  already deep for its posture. This ADR only extracts the shared
  response helpers (`jsonResponse`, `errorResponse`) into
  `lib/httpResponse.ts` so both factories consume one source. A
  follow-up ADR may document the **API-key endpoint (module)**
  surface in `CONTEXT.md` for completeness.
- **Webhook ingestion shell** (`webhookIngestion` rate-limit type
  exists). No current public-token endpoint uses it; the inbound
  webhook adapters at `webhooks/` use their own shape. Lifting them
  into `publicTokenEndpoint` would require a third auth posture
  (HMAC-signed) and is deferred.
- **Multipart body parsing into the shell**. `forms/apiHttp.ts`
  keeps its local `parseFormData` because it's the only multipart
  caller. The shell's `body: 'formData'` config — if implemented —
  routes through that local helper; otherwise the form endpoint
  uses `body: 'none'` and parses inline. Decision deferred to
  execution.

## Consequences

**Closes the silent-fragility gap on path indexing and decoding.**
Every public-token shell becomes a declarative route with named
segments and uniform URL decoding. Route prefix changes are
compile-time-visible at declaration; today they are a runtime
behaviour change with no signal.

**Closes the error envelope drift across the public surface.** One
shape for action-mode 4xx, one shape for outcome-mode 200. Frontend
callers handle one shape across all public-token endpoints. New
endpoints inherit the shape.

**Honours the existing `createAuthenticatedHandler` precedent.** The
factory pattern is the same; the auth posture differs. Two sibling
factories, one per posture, both consuming
`lib/httpResponse.ts`. The codebase's HTTP shell discipline lands
on one footing.

**Surface area:** net negative. ~956 LOC of open-coded shell across
6 files becomes ~210 LOC of declarations + ~250 LOC factory + ~80
LOC response helpers + ~120 LOC of tests = ~660 LOC, net ~300 LOC
deleted. The factory file becomes the test surface for every
shell-shape concern; today none of those concerns have any test
surface.

**Migration:** one PR. Schema unchanged. No data migration.

1. New `convex/lib/httpResponse.ts` with `jsonResponse`,
   `errorResponse`, and `publicCorsHeaders` wrapper.
2. New `convex/lib/publicTokenEndpoint.ts` with the factory, path
   matcher, and body parser dispatch.
3. `auth/apiAuth.ts:jsonResponse` and `errorResponse` deleted;
   imports updated to point at `lib/httpResponse.ts`.
4. Nine endpoints across six files migrate from open-coded
   `httpAction` to `publicTokenEndpoint(...)`. The HTTP route table
   (`convex/http.ts`) is unchanged — the factory returns the same
   `httpAction` shape Convex registers.
5. Three frontend callers in `apps/web` migrate to the locked error
   envelope: unsubscribe verify page, preferences verify page,
   share/archive error rendering. Each is ~5 LOC.
6. New tests at `convex/lib/__tests__/publicTokenEndpoint.test.ts`
   and `convex/lib/__tests__/httpResponse.test.ts`.
7. CONTEXT.md entry for **Public token endpoint (module)** already
   landed inline with the grilling that produced this ADR; the
   **Form submission (module)** entry cross-references the new
   shell.

**Risk to in-flight calls:** none on the wire contract for the
sites that already used `{ error: { message, code } }`. The three
sites that returned `{ error: 'msg' }` become `{ error: { message,
code } }` — RFC 8058 clients ignore the body; the two share/archive
sites have frontend updates in the same PR. The two "200 on invalid"
verify endpoints become `{ ok: false, reason }` instead of
`{ valid: false, error, reason }` — frontend updates in the same PR.
The `updatePreferences` 400-on-invalid case becomes `{ error: {
message, code } }` — frontend updates in the same PR.

**No risk to existing rate-limit behaviour.** The shell calls the
same `internal.publicRateLimit.checkPublicRateLimit` mutation with
the same `limitType` literal each site already passes. Rate-limit
buckets, response shape on miss (`Retry-After`), and the IP
extraction (`getClientIp`) are unchanged.

**Out of scope for follow-up:** the API-key endpoint CONTEXT.md
documentation, the tracking endpoint factory (if a third graceful
endpoint appears), the webhook ingestion shell (if HMAC-signed
inbound webhooks consolidate to a third factory), and lifting
multipart body parsing into the shell (if a second multipart caller
appears). None of those is pre-committed by this ADR.
