'use node';

/**
 * TypeSafe (Jev) decision adapter — the native decision endpoint, over our own
 * HTTP client.
 *
 * ONE endpoint: `POST <baseUrl>/v1/systemone`, bearer auth, one model id. The
 * request is `{ model, state, questions }` and the response is one typed answer
 * per question plus a token count. There is no stream, no prose and no schema
 * to repair, so there is nothing in the vendor's Node SDK we would use except
 * its error classes — and we already have an error taxonomy. So: no new npm
 * dependency, for the same reason `packages/smtp-client` and
 * `packages/mail-message` exist. A dependency on the send path of customer mail
 * has to earn itself, and forty lines of `fetch` do not.
 *
 * WHAT THIS FILE OWNS: the transport and the failure taxonomy. The vendor's
 * request/response VOCABULARY lives in `./wire.ts` and nothing here spells
 * `noul`, `legend` or `input_tokens`.
 *
 * Base URL convention — the settings card should say this verbatim: paste the
 * API ORIGIN (`https://api.typesafe.ai`), not a full endpoint. The adapter
 * appends `/v1/systemone` itself, so an operator fronting the API with a proxy
 * pastes the proxy's origin and everything else keeps working. A base URL that
 * already carries the endpoint path is refused by {@link validateCredentials}
 * rather than silently producing `…/v1/systemone/v1/systemone`.
 *
 * Four properties of the request, each deliberate:
 *
 *   • It goes through `lib/ssrfGuard.fetchGuarded`, https-only, because a
 *     decrypted key rides it and an operator-supplied base URL must never be
 *     able to point that key at an internal host. The guard REFUSES redirects,
 *     so a 3xx from the vendor surfaces here as an actionable "your base URL
 *     redirects" rather than a confusing SSRF failure.
 *   • It always carries a deadline. `fetchGuarded` passes `init` straight
 *     through and adds no timeout of its own, and a plane whose selling point
 *     is a sub-second answer must not inherit an unbounded socket. The caller's
 *     own `abortSignal` is composed with ours, so a cancelled pipeline step
 *     cancels the socket.
 *   • It pins the MODEL VERSION. `jev-latest` and `jev-preview` both point at
 *     `jev-1.13.0` today; a silent model swap underneath a threshold that gates
 *     sending mail is the worst version of this idea, so we name the version
 *     and a bump re-runs the calibration harness first. An operator who names a
 *     different id (the settings picker, or `DECISION_MODEL`) gets the id they
 *     asked for — what is never silent is the RESULT: an answer the provider
 *     reports against anything but the pinned version comes back
 *     `calibrated: false`, so every threshold downstream goes inert until the
 *     calibration harness has been re-run against it. That covers the
 *     operator's deliberate bump and a vendor-side reroute with one rule.
 *   • The API key appears in exactly one place — the `Authorization` header.
 *     Never in a thrown message, never in a log line; any echo of a vendor
 *     error body is redacted against the key before it is quoted.
 *
 * Retry is NOT decided here: errors are stamped with the vendor's status and
 * classified by the repo's one classifier, `isRetriableLlmError`, so 429 and
 * every 5xx (529 included, via its `>= 500` branch) are retriable and
 * 401/403/404/422 are not. A `DecisionWireError` from the codec passes through
 * untouched: a response that disagrees with the question set we sent is a hard
 * error and re-asking would only corrupt the calibration statistics.
 */

import { isRetriableLlmError } from '../llm/dispatch';
import {
	FetchGuardError,
	RedirectRefusedError,
	SsrfBlockedError,
	fetchGuarded,
} from '../ssrfGuard';
import { validateOutboundUrl } from '../outboundUrlValidation';
import type { ProviderClientConfig } from '../llmProviders/types';
import type { DecisionProviderAdapter, DecisionRequest, DecisionResult } from './types';
import { DecisionWireError, decodeResponse, encodeQuestions } from './wire';

/** The vendor's own API origin. An operator only overrides this for a proxy. */
export const TYPESAFE_DEFAULT_BASE_URL = 'https://api.typesafe.ai';

/** The single endpoint, appended to whichever origin is configured. */
export const TYPESAFE_DECISION_PATH = '/v1/systemone';

/**
 * The pinned model version, never an alias. See the header: `jev-latest` and
 * `jev-preview` resolve here today and are free to move without notice.
 */
export const PINNED_DECISION_MODEL = 'jev-1.13.0';

/** The aliases that point at {@link PINNED_DECISION_MODEL}, newest-first. */
export const JEV_MODEL_ALIASES = ['jev-latest', 'jev-preview'] as const;

/**
 * Whether a model id the PROVIDER reported is the version our thresholds were
 * calibrated against. Aliases can move, so they cannot prove the version that
 * answered. Anything other than the exact pinned id is a
 * version we have not measured — whether the operator asked for it or the vendor
 * rerouted us onto it — and the answer is honest about that rather than trusted.
 */
export function isPinnedDecisionModel(modelUsed: string): boolean {
	const reported = modelUsed.trim();
	return reported === PINNED_DECISION_MODEL;
}

/**
 * Default per-request deadline. Their one published timing figure is 0.27 s for
 * a batched 13-question call over ~54k characters, so ten seconds is roughly
 * forty times the measured latency: generous enough that a slow day is not an
 * outage, tight enough that a stalled socket cannot outlive the pipeline step
 * that is waiting on it. The dispatch overrides it per surface.
 */
export const DEFAULT_DECISION_DEADLINE_MS = 10_000;

/**
 * The one wording for a 3xx, whether the guard refused it on the way out or an
 * injected fetcher handed it back as a response. A redirect is always the same
 * mistake — a base URL that does not serve the endpoint itself.
 */
const REDIRECT_MESSAGE =
	'TypeSafe answered with a redirect, which is refused rather than followed. Set the base URL ' +
	`to the API origin that serves the endpoint directly (default ${TYPESAFE_DEFAULT_BASE_URL}).`;

/** How much of a vendor error body is quoted back to the operator. */
const MAX_ERROR_DETAIL_LENGTH = 200;

/**
 * A failed decision round trip, carrying everything the dispatch needs to
 * decide what happens next.
 *
 * `status` is named the way `isRetriableLlmError` reads it, so the shared
 * classifier applies unchanged — this file states no retry rules of its own.
 * `retriable` is pre-computed through that same classifier and only overridden
 * where there is no HTTP status to classify (a refused redirect is a
 * configuration mistake, a timeout is a transient one). `retryAfterMs` carries
 * the vendor's `Retry-After` when they push back, which is authoritative: one
 * shared upstream bucket plus our synchronized ingest is exactly the shape that
 * produces a retry storm.
 */
export class TypeSafeDecisionError extends Error {
	readonly status?: number;
	readonly retryAfterMs?: number;
	readonly retriable: boolean;

	constructor(
		message: string,
		options: { status?: number; retryAfterMs?: number; retriable?: boolean; cause?: unknown } = {}
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'TypeSafeDecisionError';
		this.status = options.status;
		this.retryAfterMs = options.retryAfterMs;
		this.retriable = options.retriable ?? isRetriableLlmError(this);
	}
}

// ─── Config ────────────────────────────────────────────────────────────────

function requireApiKey(cfg: ProviderClientConfig): string {
	if (!cfg.apiKey) {
		throw new Error('TypeSafe (Jev) requires an API key.');
	}
	return cfg.apiKey;
}

/** The configured origin, without its trailing slash. */
function originOf(cfg: ProviderClientConfig): string {
	return (cfg.baseUrl ?? TYPESAFE_DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function decisionEndpoint(cfg: ProviderClientConfig): string {
	return `${originOf(cfg)}${TYPESAFE_DECISION_PATH}`;
}

/**
 * The fetch the round trip runs on. Production leaves `fetchImpl` unset and
 * gets the SSRF-guarded, https-only fetcher: the key rides this request, so an
 * operator-supplied base URL must never be able to walk it to an internal host
 * or follow a redirect off one. Tests (and the settings action, which already
 * supplies a guarded fetcher of its own) inject their own.
 */
function fetcherFor(
	cfg: ProviderClientConfig
): (input: string, init?: RequestInit) => Promise<Response> {
	return (
		cfg.fetchImpl ?? ((input, init) => fetchGuarded(input, { ...init, protocols: ['https:'] }))
	);
}

// ─── Failure mapping ───────────────────────────────────────────────────────

/** Strip any occurrence of the key from text that is about to be thrown or logged. */
function redactKey(text: string, apiKey: string): string {
	return apiKey.length === 0 ? text : text.split(apiKey).join('[redacted]');
}

/** `AbortSignal.timeout` rejects with a DOMException named 'TimeoutError'. */
function isAbortLike(error: unknown): boolean {
	return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * Map a thrown fetch failure — before any response arrived — onto the taxonomy.
 * The guard's refusals are matched by TYPE, not by message text, so rewording
 * `fetchGuarded` cannot silently demote a blocked destination to "network
 * blip" and hand it a retry budget. Returns `unknown` rather than the error
 * class because one case deliberately passes a value through untouched: a
 * caller's own cancellation reason.
 */
function transportError(error: unknown, req: DecisionRequest, deadlineMs: number): unknown {
	// A caller who cancelled gets their own reason back, not a vendor error:
	// cancellation is not a failure of the provider and must not be retried.
	if (req.abortSignal?.aborted) {
		return req.abortSignal.reason ?? error;
	}
	if (isAbortLike(error)) {
		return new TypeSafeDecisionError(
			`TypeSafe did not answer within the ${deadlineMs} ms deadline.`,
			{ retriable: true, cause: error }
		);
	}
	if (error instanceof RedirectRefusedError) {
		return new TypeSafeDecisionError(REDIRECT_MESSAGE, { retriable: false, cause: error });
	}
	if (error instanceof SsrfBlockedError) {
		return new TypeSafeDecisionError(
			'The configured TypeSafe base URL resolves to a private or internal address and was blocked.',
			{ retriable: false, cause: error }
		);
	}
	if (error instanceof FetchGuardError) {
		return new TypeSafeDecisionError(
			'The configured TypeSafe base URL was refused before the request left the deployment. ' +
				'It must be an https origin on a public host.',
			{ retriable: false, cause: error }
		);
	}
	return new TypeSafeDecisionError('TypeSafe could not be reached (connection failure).', {
		retriable: true,
		cause: error,
	});
}

/** `Retry-After` as milliseconds, in either of its two documented forms. */
function retryAfterMs(response: Response): number | undefined {
	const header = response.headers.get('retry-after');
	if (!header) return undefined;
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
	const at = Date.parse(header);
	return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** What each status means for the operator reading it, in their words not HTTP's. */
function statusMessage(status: number): string {
	if (status >= 300 && status < 400) {
		return REDIRECT_MESSAGE;
	}
	switch (status) {
		case 400:
			return 'TypeSafe rejected the request as malformed (HTTP 400).';
		case 401:
			return 'TypeSafe rejected the API key (HTTP 401). Check the key in the AI provider settings.';
		case 403:
			return 'The TypeSafe API key is not permitted to use this endpoint or model (HTTP 403).';
		case 404:
			return `TypeSafe has no endpoint at ${TYPESAFE_DECISION_PATH} for the configured base URL (HTTP 404). The base URL must be the API origin only.`;
		case 422:
			return 'TypeSafe rejected the question set as invalid (HTTP 422).';
		case 429:
			return 'TypeSafe rate-limited the request (HTTP 429).';
		default:
			return status >= 500
				? `TypeSafe is unavailable or overloaded (HTTP ${status}).`
				: `TypeSafe returned HTTP ${status}.`;
	}
}

/**
 * Quote a little of the vendor's error body so an operator has something to act
 * on — truncated, single-line, and redacted against the key first. Reading the
 * body must never turn one failure into a different one, so a body that cannot
 * be read simply adds nothing.
 */
async function errorDetail(response: Response, apiKey: string): Promise<string> {
	let body: string;
	try {
		body = await response.text();
	} catch {
		return '';
	}
	const detail = redactKey(body, apiKey).replace(/\s+/g, ' ').trim();
	if (detail.length === 0) return '';
	const quoted =
		detail.length > MAX_ERROR_DETAIL_LENGTH
			? `${detail.slice(0, MAX_ERROR_DETAIL_LENGTH)}…`
			: detail;
	return ` ${quoted}`;
}

async function responseError(response: Response, apiKey: string): Promise<TypeSafeDecisionError> {
	const status = response.status;
	const detail = await errorDetail(response, apiKey);
	// A 3xx can only reach here through an injected fetcher that follows or
	// surfaces redirects; the guard refuses them earlier. Same message either way.
	const retriable = status >= 300 && status < 400 ? false : undefined;
	return new TypeSafeDecisionError(`${statusMessage(status)}${detail}`, {
		status,
		retriable,
		retryAfterMs: retryAfterMs(response),
	});
}

// ─── The adapter ───────────────────────────────────────────────────────────

/**
 * Compose the plane's own deadline with the caller's cancellation, so whichever
 * fires first aborts the socket.
 */
function deadlineSignal(req: DecisionRequest, deadlineMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(deadlineMs);
	return req.abortSignal ? AbortSignal.any([req.abortSignal, timeout]) : timeout;
}

export const typesafeDecisionAdapter: DecisionProviderAdapter<'typesafe'> = {
	kind: 'typesafe',
	label: 'TypeSafe (Jev)',
	docsUrl: 'https://docs.typesafe.ai/api',
	defaultBaseUrl: TYPESAFE_DEFAULT_BASE_URL,
	defaultModel: PINNED_DECISION_MODEL,
	calibrated: true,
	isLocal: false,
	requiresApiKey: true,
	apiKeyEnv: 'TYPESAFE_API_KEY',
	defaultDeadlineMs: DEFAULT_DECISION_DEADLINE_MS,
	defaultEndpointProvenance: 'typesafe-native',
	handlesRetries: false,

	async ask(cfg: ProviderClientConfig, req: DecisionRequest): Promise<DecisionResult> {
		const apiKey = requireApiKey(cfg);
		const deadlineMs = req.deadlineMs ?? DEFAULT_DECISION_DEADLINE_MS;
		// Encoded BEFORE the socket is opened: an empty or malformed question set
		// is our bug and should not cost a round trip to discover.
		const questions = encodeQuestions(req.questions);

		let response: Response;
		try {
			response = await fetcherFor(cfg)(decisionEndpoint(cfg), {
				method: 'POST',
				headers: {
					authorization: `Bearer ${apiKey}`,
					'content-type': 'application/json',
					accept: 'application/json',
				},
				body: JSON.stringify({
					// The resolver's id when the operator named one, the pin otherwise.
					model: req.modelId?.trim() || PINNED_DECISION_MODEL,
					state: req.state,
					questions,
				}),
				signal: deadlineSignal(req, deadlineMs),
			});
		} catch (error) {
			throw transportError(error, req, deadlineMs);
		}

		if (!response.ok || (response.status >= 300 && response.status < 400)) {
			throw await responseError(response, apiKey);
		}

		let body: unknown;
		try {
			body = await response.json();
		} catch (error) {
			if (isAbortLike(error) || req.abortSignal?.aborted) {
				throw transportError(error, req, deadlineMs);
			}
			throw new TypeSafeDecisionError(
				'TypeSafe answered with a body that is not JSON. Check that the base URL points at the ' +
					'API rather than a gateway or a login page.',
				{ retriable: false, cause: error }
			);
		}

		// Anything the codec refuses here is a disagreement between our question
		// set and their answer — thrown as a `DecisionWireError`, never repaired
		// and never retried.
		const decoded = (() => {
			try {
				return decodeResponse(req.questions, body);
			} catch (error) {
				if (error instanceof DecisionWireError) {
					throw new DecisionWireError(
						redactKey(error.message, apiKey),
						error.usage && error.modelUsed
							? { usage: error.usage, modelUsed: redactKey(error.modelUsed, apiKey) }
							: undefined
					);
				}
				throw error;
			}
		})();
		return {
			answers: decoded.answers,
			usage: decoded.usage,
			modelUsed: decoded.modelUsed,
			provenance: cfg.baseUrl !== undefined ? 'custom' : 'typesafe-native',
			// The answer is calibrated only if it came from the version the
			// thresholds were measured against. A provider-side reroute onto another
			// version is exactly what reading the model id back is for, and treating
			// one as calibrated would put an unmeasured model under a gate that
			// decides whether mail is sent.
			calibrated: isPinnedDecisionModel(decoded.modelUsed),
		};
	},

	validateCredentials(cfg: ProviderClientConfig): void {
		requireApiKey(cfg);
		if (cfg.baseUrl !== undefined) {
			// The same rule `_persistConfig` applies to a base URL typed on the
			// settings page, applied here so it also covers the one that arrives as
			// `DECISION_BASE_URL`. An env origin used to reach the adapter having
			// been checked by nothing but the SSRF guard, which refuses private
			// hosts but not `https://user:pass@host` — and the key rides this
			// request, so an origin carrying someone else's credentials is the one
			// shape worth refusing before a socket is opened rather than after.
			const check = validateOutboundUrl(originOf(cfg), { requirePublic: true });
			if (!check.ok) {
				throw new Error(`The TypeSafe base URL ${check.error}.`);
			}
			// The one configuration mistake worth naming: the endpoint path belongs
			// to the adapter, so pasting the full endpoint would double it. Caught
			// here so the settings test button explains it instead of a 404.
			if (originOf(cfg).endsWith(TYPESAFE_DECISION_PATH)) {
				throw new Error(
					`The TypeSafe base URL must be the API origin (e.g. ${TYPESAFE_DEFAULT_BASE_URL}); ` +
						`${TYPESAFE_DECISION_PATH} is appended automatically.`
				);
			}
		}
	},

	/**
	 * The vendor publishes no model-listing endpoint — the HTTP reference
	 * documents exactly one route, the decision endpoint itself — so this is the
	 * documented catalog rather than a discovery call, and it makes no request.
	 * The pinned version comes first because it is what the plane actually sends;
	 * the two aliases are listed so an operator can recognise them, not because
	 * we recommend configuring one (see the header on pinning). Revisit if they
	 * ever ship `/v1/models`.
	 */
	async listModels(cfg: ProviderClientConfig): Promise<string[]> {
		requireApiKey(cfg);
		return [PINNED_DECISION_MODEL, ...JEV_MODEL_ALIASES];
	},
};
