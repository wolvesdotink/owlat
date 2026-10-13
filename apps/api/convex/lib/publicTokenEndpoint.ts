/**
 * Public token endpoint (module) — the shell shape factory for every
 * public, token-keyed, no-session `httpAction` in this codebase.
 *
 * Sibling of `auth/apiAuth.ts:createAuthenticatedHandler` (API-key posture).
 * Both factories consume `lib/httpResponse.ts` for the locked envelope.
 *
 * The shell owns:
 *
 *   1. CORS preflight (`OPTIONS` → 204 with the declared methods header)
 *   2. Method gate     (anything other than `config.method` → 405)
 *   3. Token extract   (named path segment first, `?token=` fallback),
 *                      decoded once (`canonicalizeToken`)
 *   4. Rate-limit gate (client IP, or IP + token digest with a per-IP
 *                      failure budget for `rateLimitKeyMode: 'ip+token'`)
 *   5. Body parse      (`'none' | 'json' | 'formData'`, 100 KB cap)
 *   6. Handler         (typed `{ token, body, request }` input)
 *   7. Result map      (`'action' | 'outcome'`)
 *
 * The handler is what each endpoint actually owns — it receives a decoded
 * token plus a parsed body and returns a typed result. The shell maps the
 * result to HTTP per `resultMode`.
 *
 * Two result modes:
 *   - `'action'`: success → `{ ok: true, data }` (or pass-through `raw`
 *     Response for 302 redirects); failure → 4xx with the locked envelope
 *     `{ error: { category, message, data? } }`.
 *   - `'outcome'`: always HTTP 200, body discriminates with `ok`. The
 *     "200 on invalid token" verify endpoints land here naturally — a
 *     successful verification request that finds an expired token is no
 *     longer mislabelled as an HTTP error.
 *
 * See docs/adr/0030-public-token-endpoint-module.md.
 */

import { readBodyBytes } from './readBody';
import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { getClientIp, rateLimitedResponse, type PublicRateLimitType } from './publicRateLimit';
import {
	errorResponse,
	jsonResponse,
	methodNotAllowed,
	publicCorsHeaders,
	type CorsMethodsHeader,
} from './httpResponse';
import type { OperationErrorCategory } from '@owlat/shared/operationError';
import { logError } from './runtimeLog';
import { safeDecodeURIComponent } from './inputGuards';

/**
 * Best-effort reverse map for the action-mode failure boundary: an endpoint
 * handler returns `{ ok: false, reason, status? }` and the shell needs an
 * Operation error category. The handler's machine-readable `reason` rides in
 * `data.reason`; the category drives the HTTP status.
 */
function statusToCategory(status: number | undefined): OperationErrorCategory {
	switch (status) {
		case 401:
			return 'unauthenticated';
		case 403:
			return 'forbidden';
		case 404:
			return 'not_found';
		case 409:
			return 'conflict';
		case 422:
			return 'invalid_state';
		case 429:
			return 'rate_limited';
		case 500:
			return 'internal';
		default:
			return status !== undefined && status >= 500 ? 'internal' : 'invalid_input';
	}
}

// Maximum request body size (100 KB).
const MAX_BODY_BYTES = 100_000;

// ─── Types ──────────────────────────────────────────────────────────────────

export type BodyParser = 'none' | 'json' | 'formData';

export interface EndpointConfig {
	/**
	 * Path pattern with literal and `:name` segments, e.g. `/unsub/:token`.
	 * The matcher extracts named params; the shell looks for a `:token` param
	 * and falls back to `?token=` if the pattern has none. Path-positional
	 * indexing (`pathParts[2]`) is the silent-fragility bug class this closes.
	 */
	path: string;
	/** HTTP method this endpoint accepts. Other methods short-circuit with 405. */
	method: 'GET' | 'POST';
	/** Rate-limit kind. Shell calls `checkPublicRateLimit` once per request. */
	rateLimit: PublicRateLimitType;
	/**
	 * What the rate-limit bucket is keyed on. Defaults to `'ip'`.
	 *
	 * `'ip+token'` mixes the decoded token into the key (`<ip>:<sha256>`). Use
	 * it for endpoints whose token is an UNFORGEABLE PER-RECIPIENT secret
	 * (unsubscribe / preferences / DOI confirm / share / archive links): each
	 * recipient then gets an isolated bucket, so when no trusted proxy is
	 * configured (every caller shares the `'unknown'` IP) a flood on one link —
	 * or on a cheap browse path — can't exhaust the shared window and block other
	 * recipients' one-click unsubscribes. Do NOT use it where the token is shared
	 * across legitimate callers (e.g. a form endpoint id), where IP is the right
	 * per-submitter key.
	 *
	 * In this mode every failed request (missing or malformed token, bad body,
	 * handler `ok: false`) also spends the caller's per-IP `publicTokenFailure`
	 * bucket, and an empty one stops new per-token buckets from being created.
	 */
	rateLimitKeyMode?: 'ip' | 'ip+token';
	/**
	 * CORS methods header. `false` opts out (e.g. RFC 8058 one-click
	 * unsubscribe — not a browser-fetch path).
	 */
	cors?: CorsMethodsHeader | false;
	/** Body parser. Defaults to `'none'`. */
	body?: BodyParser;
	/**
	 * `'action'`: success → 200 `{ ok: true, data }` (or pass-through `raw`),
	 * failure → 4xx `{ error: { category, message, data? } }`.
	 *
	 * `'outcome'`: always 200, body is `{ ok, data | reason }`.
	 */
	resultMode: 'action' | 'outcome';
}

/**
 * Action-mode handler result. The shell wraps `{ ok: true, data }` in
 * `{ ok: true, data }` and maps `{ ok: false, reason, message?, status? }` to a
 * 4xx with the locked error envelope: the `status` selects the Operation error
 * category, the `reason` (machine-readable code) rides in `data.reason`, and
 * `message` is the user-facing string (defaults to `reason` when omitted).
 * `headers` (optional) merges into the success response — used for
 * `Cache-Control` on share-link / archive reads. `{ ok: true, raw }` is an
 * escape hatch — the shell applies CORS headers and passes the Response
 * through unchanged. Used by the form-submit endpoint's 302 redirect path.
 *
 * The `data` is intentionally typed `unknown` at the shell layer — each
 * endpoint owns its own response shape and the shell only knows how to
 * serialize it as JSON. Threading the `data` type through the factory
 * generics triggers a circular type-reference through the generated Convex
 * API surface when a file's `*Http.ts` exports collide with a sibling
 * module (`preferences.ts` ↔ `preferencesHttp.ts`).
 */
export type ResultAction =
	| { ok: true; data: unknown; headers?: Record<string, string> }
	| { ok: true; raw: Response }
	| { ok: false; reason: string; message?: string; status?: number };

/**
 * Outcome-mode handler result. The shell always returns HTTP 200; the body
 * discriminates between `ok: true` and `ok: false`. "200 on invalid token"
 * verify endpoints land here.
 */
export type ResultOutcome = { ok: true; data: unknown } | { ok: false; reason: string };

/**
 * Subset of the Convex action ctx that the handler is allowed to see.
 * Mirrors the existing public/auth handler context shapes.
 */
export interface HandlerContext {
	runQuery: <T>(query: unknown, args: unknown) => Promise<T>;
	runMutation: <T>(mutation: unknown, args: unknown) => Promise<T>;
	runAction: <T>(action: unknown, args: unknown) => Promise<T>;
}

export interface HandlerArgs {
	token: string;
	/**
	 * Parsed body. Type depends on the `body` config:
	 *   - `'none'` (default): `undefined`
	 *   - `'json'`:           `unknown` — handler must validate the shape
	 *   - `'formData'`:       `Record<string, string>` — JSON / urlencoded /
	 *                         multipart all flatten to a key→value map
	 *
	 * Typed `unknown` at the boundary to keep the factory generics flat —
	 * threading a body-type generic through the export triggered a circular
	 * type-reference through the generated Convex API surface (the `*Http.ts`
	 * file's exports collided with the sibling module name during inference).
	 */
	body: unknown;
	request: Request;
}

// ─── Path matcher ──────────────────────────────────────────────────────────

/**
 * Compile a `/literal/:name/...` path pattern into a function that either
 * returns the captured params or `null` for non-matching pathnames.
 *
 * Supports literal segments and `:name` parameter segments only — no regex,
 * no optionals, no wildcards. Twenty lines, no external dependency.
 *
 * Exported for unit tests.
 */
export function compilePath(pattern: string) {
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

// ─── Body parser ───────────────────────────────────────────────────────────

/**
 * Parse the request body per the declared body mode. Throws on size violation
 * or content-type mismatch; the shell maps the throw to a 400 with the
 * locked envelope.
 */
export async function parseBody(request: Request, mode: BodyParser): Promise<unknown> {
	if (mode === 'none') {
		return undefined;
	}

	const bytes = await readBodyBytes(request, MAX_BODY_BYTES);
	const bounded = new Request(request.url, {
		method: request.method,
		headers: request.headers,
		body: bytes,
	});

	const contentType = request.headers.get('Content-Type') || '';

	if (mode === 'json') {
		const text = await bounded.text();
		if (text.length === 0) {
			return undefined;
		}
		try {
			return JSON.parse(text);
		} catch {
			throw new Error('Invalid JSON in request body');
		}
	}

	// mode === 'formData' — accepts JSON, urlencoded, or multipart.
	if (contentType.includes('application/json')) {
		const text = await bounded.text();
		if (text.length === 0) {
			return {};
		}
		try {
			return JSON.parse(text);
		} catch {
			throw new Error('Invalid JSON in request body');
		}
	}
	if (contentType.includes('application/x-www-form-urlencoded')) {
		const text = await bounded.text();
		const params = new URLSearchParams(text);
		const data: Record<string, string> = {};
		params.forEach((value, key) => {
			data[key] = value;
		});
		return data;
	}
	if (contentType.includes('multipart/form-data')) {
		let formData: FormData;
		try {
			formData = await bounded.formData();
		} catch {
			throw new Error('Invalid form data');
		}
		const data: Record<string, string> = {};
		for (const [key, value] of formData.entries()) {
			if (typeof value === 'string') data[key] = value;
		}

		return data;
	}
	throw new Error('Unsupported content type. Use JSON or form-urlencoded.');
}

// ─── Token ─────────────────────────────────────────────────────────────────

/**
 * Longest decoded token the shell accepts. Every token the app issues is far
 * shorter; the cap keeps arbitrary request text out of the limiter and lookups.
 */
export const MAX_TOKEN_LENGTH = 512;

/**
 * Decode the extracted token once and check it. The result is both the
 * handler's token and the rate-limit identity, so two spellings of one token
 * (`%73` vs `s`, `%3A` vs `%3a`) are the same token everywhere.
 *
 * Exported for unit tests.
 */
export function canonicalizeToken(
	tokenRaw: string | null
): { ok: true; token: string } | { ok: false; message: string } {
	if (!tokenRaw) return { ok: false, message: 'Missing token' };
	const token = safeDecodeURIComponent(tokenRaw);
	if (token === null) return { ok: false, message: 'Invalid token encoding' };
	if (token.length > MAX_TOKEN_LENGTH) return { ok: false, message: 'Token too long' };
	return { ok: true, token };
}

/** SHA-256 of a string as lowercase hex. */
async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── CORS overlay ──────────────────────────────────────────────────────────

function applyCors(response: Response, corsHeaders: Record<string, string> | null): Response {
	if (!corsHeaders) return response;
	const headers = new Headers(response.headers);
	for (const [key, value] of Object.entries(corsHeaders)) {
		headers.set(key, value);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

// ─── Shell ─────────────────────────────────────────────────────────────────

/**
 * Build the inner async function that processes one request. Extracted so
 * tests can drive it against a mock `ctx` and a real `Request` without
 * going through `httpAction`.
 *
 * Exported for unit tests. Production code calls `publicTokenEndpoint`.
 */
export function createShellHandler(
	config: EndpointConfig,
	handler: (ctx: HandlerContext, args: HandlerArgs) => Promise<ResultAction | ResultOutcome>
): (ctx: HandlerContext, request: Request) => Promise<Response> {
	const matcher = compilePath(config.path);
	const corsHeaders: Record<string, string> | null =
		config.cors === false ? null : publicCorsHeaders(config.cors ?? 'GET, OPTIONS');

	return async (ctx, request) => {
		// 1. CORS preflight.
		if (corsHeaders && request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders });
		}

		// 2. Method gate.
		if (request.method !== config.method) {
			return methodNotAllowed('Method not allowed', corsHeaders);
		}

		// 3. Token extract — `:token` path segment first, `?token=` fallback,
		// decoded once. The decoded value is what the handler gets and what an 'ip+token'
		// bucket is keyed on, so `/x/abc` and `/x/%61bc` share one bucket.
		const url = new URL(request.url);
		const pathMatch = matcher(url.pathname);
		const tokenRaw = pathMatch?.['token'] ?? url.searchParams.get('token') ?? null;
		const parsedToken = canonicalizeToken(tokenRaw);
		const perToken = config.rateLimitKeyMode === 'ip+token';
		const ip = getClientIp(request);

		// 4. Rate-limit gate. For per-recipient token endpoints the bucket is keyed
		// on `<ip>:<sha256(token)>` so a flood on one link (or, when no trusted
		// proxy is configured, the shared 'unknown' IP) can't starve another
		// recipient's bucket, and the stored key never holds the token itself.
		// Invented tokens are metered by the per-IP `publicTokenFailure` bucket
		// (see `checkPublicTokenRateLimit`). IP-only endpoints keep the plain IP
		// key.
		if (perToken && parsedToken.ok) {
			const { ok, retryAfter } = await ctx.runMutation<{ ok: boolean; retryAfter: number }>(
				internal.lib.publicRateLimit.checkPublicTokenRateLimit,
				{ limitType: config.rateLimit, ip, tokenDigest: await sha256Hex(parsedToken.token) }
			);
			if (!ok) {
				return rateLimitedResponse(retryAfter, { corsHeaders: corsHeaders ?? undefined });
			}
		} else {
			const { ok, retryAfter } = await ctx.runMutation<{ ok: boolean; retryAfter: number }>(
				internal.lib.publicRateLimit.checkPublicRateLimit,
				{ limitType: perToken ? 'publicTokenFailure' : config.rateLimit, key: ip }
			);
			if (!ok) {
				return rateLimitedResponse(retryAfter, { corsHeaders: corsHeaders ?? undefined });
			}
		}

		if (!parsedToken.ok) {
			return errorResponse('invalid_input', parsedToken.message, undefined, corsHeaders);
		}
		const token = parsedToken.token;

		// A failed request on a per-token endpoint spends the caller's
		// `publicTokenFailure` bucket. Missing or malformed tokens already did, above.
		const recordFailure = async () => {
			if (!perToken) return;
			await ctx.runMutation(internal.lib.publicRateLimit.checkPublicRateLimit, {
				limitType: 'publicTokenFailure',
				key: ip,
			});
		};

		// 5. Body parse.
		let body: unknown;
		try {
			body = await parseBody(request, config.body ?? 'none');
		} catch (error) {
			await recordFailure();
			const message = error instanceof Error ? error.message : 'Invalid body';
			return errorResponse('invalid_input', message, undefined, corsHeaders);
		}

		// 6. Handler.
		let result: ResultAction | ResultOutcome;
		try {
			result = await handler(ctx, { token, body, request });
		} catch (error) {
			logError(`[${config.path}] handler threw:`, error);
			return errorResponse('internal', 'Internal error', undefined, corsHeaders);
		}

		if (!result.ok) await recordFailure();

		// 7. Map result by mode.
		if (config.resultMode === 'outcome') {
			// Always 200 — body discriminates with `ok`.
			return jsonResponse(result, 200, corsHeaders);
		}
		// Action mode — `resultMode === 'action'` narrows runtime, but TS can't
		// infer the result narrowing from `config.resultMode`. Cast it.
		const action = result as ResultAction;
		if (action.ok) {
			if ('raw' in action) {
				return applyCors(action.raw, corsHeaders);
			}
			const combinedHeaders = action.headers ? { ...corsHeaders, ...action.headers } : corsHeaders;
			return jsonResponse({ ok: true, data: action.data }, 200, combinedHeaders);
		}
		return errorResponse(
			statusToCategory(action.status),
			action.message ?? action.reason,
			{ reason: action.reason },
			corsHeaders
		);
	};
}

/**
 * Factory entry point — wraps a typed handler in an `httpAction` with the
 * shell shape applied.
 *
 * The handler's return type is the union `ResultAction<T> | ResultOutcome<T>`
 * because pinning it tighter to `config.resultMode` triggers a circular
 * type-reference through the generated Convex API surface (the export
 * lands at `api.{module}.{name}` and the inferred return type can loop
 * back through it). At runtime the shell branches on `config.resultMode`
 * and maps the handler's return to the right HTTP shape; misuse (returning
 * an action-shaped result from an outcome endpoint) is caught by the
 * shape-level shell tests rather than at the declaration.
 */
export function publicTokenEndpoint(
	config: EndpointConfig,
	handler: (ctx: HandlerContext, args: HandlerArgs) => Promise<ResultAction | ResultOutcome>
) {
	const inner = createShellHandler(config, handler);
	return httpAction(async (ctx, request) => inner(ctx as unknown as HandlerContext, request));
}
