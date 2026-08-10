'use node';

/**
 * Mailchimp Transactional (Mandrill) Send provider adapter (module).
 *
 * Per ADR-0020, plan D1–D5. The MIGRATION arm: a team arriving from Mailchimp
 * keeps sending through their existing Mandrill account while the shipped ramp
 * controller walks traffic onto Owlat's own MTA cell by cell. Mandrill is
 * therefore just another reference arm — nothing in routing, the ramp, or the
 * measurement plane knows this file exists.
 *
 * Shaped on `resend/index.ts` (the other HTTP-API ESP): a per-`transport.id`
 * config cache and a timeout wrapper around one single-attempt call. Two things
 * differ, and both are decisions rather than accidents:
 *
 *  - **We send our own MIME (D3).** Owlat's composition pipeline IS the product:
 *    first-party open/click tracking, RFC 8058 one-click unsubscribe headers,
 *    `Feedback-ID`, `List-Id`, a plain-text part derived from the UNTRACKED
 *    HTML. So this adapter composes the whole message with `@owlat/mail-message`
 *    exactly as `smtp/index.ts` does and posts it to `messages/send-raw` with
 *    every Mandrill feature that would rewrite or re-instrument it turned OFF.
 *    Mandrill `open`/`click` webhook events are ignored for the same reason: both
 *    arms must be measured on identical instrumentation or the `engagement_ratio`
 *    ramp gate is comparing two different rulers.
 *  - **A timeout is TERMINAL (D4).** Mandrill's API has no idempotency key, so a
 *    timed-out request may or may not have been accepted. Retrying would
 *    double-deliver, which is why this returns `AMBIGUOUS_TIMEOUT` +
 *    `acceptanceUnknown` — the SES posture, never the Resend one.
 *
 * This module runs on the `'use node'` delivery worker: `@owlat/mail-message`
 * composes into a Node `Buffer`.
 */

import { composeMessage } from '@owlat/mail-message';
import { withTimeout } from '../../inputGuards';
import {
	EmailErrorCode,
	type DispatchExtrasInput,
	type EmailSendAttempt,
	type EmailSendParams,
	type MandrillExtras,
	type SendProviderModule,
} from '../types';
import { sendProviderCatalogEntry } from '../catalog';
import { transportEnvOptional, transportEnvRequired } from '../transportEnv';
import type { SendTransportRecord } from '../transports';
import {
	categorizeMandrillError,
	isAmbiguousMandrillTimeout,
	parseRetryAfterMs,
	MANDRILL_SEND_TIMEOUT_MESSAGE,
	MANDRILL_SEND_TIMEOUT_MS,
} from './errors';

export {
	categorizeMandrillError,
	isAmbiguousMandrillTimeout,
	parseRetryAfterMs,
	MANDRILL_SEND_TIMEOUT_MESSAGE,
	MANDRILL_SEND_TIMEOUT_MS,
} from './errors';

/**
 * Mandrill's raw-message endpoint. Constant, not configurable: the EU region is
 * served from this same host, and a per-deployment base URL would be an
 * SSRF-shaped knob on a path that carries an API key in the request body.
 */
const MANDRILL_SEND_RAW_URL = 'https://mandrillapp.com/api/1.0/messages/send-raw';

/**
 * The instance-level configuration one Mandrill transport sends with.
 *
 * Cached per CONFIGURED TRANSPORT, not per deployment: two `mandrill`
 * transports carry different API keys, so caching by kind would leak the first
 * instance's credential into the second one's sends. Same rule as the Resend
 * client cache and the relay config cache.
 */
interface MandrillClientConfig {
	readonly apiKey: string;
	readonly subaccount: string | undefined;
	readonly defaultIpPool: string | undefined;
}

const cachedConfigs = new Map<string, MandrillClientConfig>();

function getClientConfig(transport: SendTransportRecord): MandrillClientConfig {
	const cached = cachedConfigs.get(transport.id);
	if (cached) return cached;
	const config: MandrillClientConfig = {
		apiKey: transportEnvRequired(transport, 'MANDRILL_API_KEY'),
		// Read HERE and not in `buildDispatchExtras`, which is env-free by
		// contract: the subaccount and the default pool are deployment
		// configuration, while extras carry only facts the ROUTE decided.
		subaccount: transportEnvOptional(transport, 'MANDRILL_SUBACCOUNT') || undefined,
		defaultIpPool: transportEnvOptional(transport, 'MANDRILL_IP_POOL') || undefined,
	};
	cachedConfigs.set(transport.id, config);
	return config;
}

/** One entry of the per-recipient array `send-raw` answers with. */
interface MandrillRecipientResult {
	readonly email?: string;
	readonly status?: string;
	readonly _id?: string;
	readonly reject_reason?: string | null;
}

/** The statuses that mean Mandrill took responsibility for the message. */
const ACCEPTED_STATUSES: ReadonlySet<string> = new Set(['sent', 'queued', 'scheduled']);

/**
 * The `messages/send-raw` request body.
 *
 * The feature-off flags are the executable form of D3 and are asserted verbatim
 * by `__tests__/sendRaw.test.ts`. They are sent UNCONDITIONALLY — never omitted
 * when falsy — because an omitted flag inherits the ACCOUNT's default, and an
 * operator who left click-tracking on in the Mandrill dashboard would otherwise
 * get every link in every campaign silently rewritten to a Mandrill redirector:
 * first-party click data would vanish from one arm only, which is precisely the
 * measurement corruption the ramp controller cannot see and cannot survive.
 */
interface MandrillSendRawBody {
	readonly key: string;
	readonly raw_message: string;
	readonly to: readonly string[];
	readonly from_email: string;
	readonly async: boolean;
	readonly track_opens: false;
	readonly track_clicks: false;
	readonly auto_html: false;
	readonly auto_text: false;
	readonly url_strip_qs: false;
	readonly preserve_recipients: false;
	readonly ip_pool?: string;
	readonly subaccount?: string;
	readonly return_path_domain?: string;
}

/**
 * Read the per-recipient array `send-raw` answers with.
 *
 * Our pipeline sends ONE recipient per send (`EmailSendParams.to` is a single
 * address), so the array has exactly one meaningful entry and the first is it.
 * A `sent | queued | scheduled` entry is a success whose `_id` becomes the
 * `providerMessageId` the webhook adapter joins on (P2.1); `rejected` and
 * `invalid` are failures even though the HTTP call succeeded.
 */
function readRecipientResult(payload: unknown): EmailSendAttempt {
	if (!Array.isArray(payload) || payload.length === 0) {
		return {
			success: false,
			errorMessage: 'Mandrill returned no per-recipient result',
			errorCode: EmailErrorCode.SERVER_ERROR,
		};
	}

	const entry = payload[0] as MandrillRecipientResult;
	const status = typeof entry?.status === 'string' ? entry.status : '';

	if (ACCEPTED_STATUSES.has(status)) {
		const id = typeof entry._id === 'string' ? entry._id : '';
		if (!id) {
			// Accepted with no id means no webhook event can ever be joined back to
			// this Send, so the lifecycle would strand. Better a classified failure
			// the dispatch loop can retry than a success we cannot track.
			return {
				success: false,
				errorMessage: 'No message ID returned from Mandrill',
				errorCode: EmailErrorCode.SERVER_ERROR,
			};
		}
		return { success: true, id };
	}

	const reason = typeof entry.reject_reason === 'string' ? entry.reject_reason : '';
	const detail = `${status || 'unknown'}: ${reason}`;
	return {
		success: false,
		errorMessage: `Mandrill ${detail.trim()}`,
		errorCode: categorizeMandrillError(detail),
	};
}

/**
 * Read Mandrill's `{ status: 'error', code, name, message }` failure body.
 *
 * `classifyText` is what the taxonomy reads and is DISCARDED afterwards;
 * `surfaced` is the only part that may reach `emailSends.errorMessage`, a log
 * sink, or an operator's screen. They are deliberately different values.
 *
 * The API KEY TRAVELS IN THE REQUEST BODY (Mandrill convention), so a proxy or
 * gateway that echoes what it received hands the credential straight back on
 * this path. Copying an unstructured body into the surfaced message would
 * therefore persist the key — which is precisely what
 * `__tests__/transportSecrets.test.ts` caught. Only the two STRUCTURED fields of
 * a body that actually parses as a Mandrill error are ever surfaced; anything
 * else is reported by HTTP status alone.
 */
function readApiError(
	body: string,
	status: number
): { surfaced: string; classifyText: string; name: string } {
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		const name = typeof parsed['name'] === 'string' ? parsed['name'] : '';
		const message = typeof parsed['message'] === 'string' ? parsed['message'] : '';
		if (name || message) {
			return {
				surfaced: name ? `${name}: ${message}` : message,
				classifyText: `${name}: ${message}`,
				name,
			};
		}
	} catch {
		// Not JSON — a gateway error page, a truncated body, or an echo of our own
		// request. Classify from the text, surface none of it.
	}
	return { surfaced: `Mandrill send failed (HTTP ${status})`, classifyText: body, name: '' };
}

/**
 * Strip the API key from anything about to leave the adapter.
 *
 * Defence in depth behind {@link readApiError}: that function already refuses to
 * surface a body it could not parse, but the STRUCTURED `message` field of a
 * body that does parse is still upstream-controlled text. The adapter is holding
 * the key at this point, so proving it absent costs one `split`.
 */
function withoutApiKey(text: string, apiKey: string): string {
	return apiKey.length > 0 ? text.split(apiKey).join('[redacted]') : text;
}

export const mandrillSendProvider: SendProviderModule<'mandrill'> = {
	kind: 'mandrill',
	retryDelays: sendProviderCatalogEntry('mandrill').retryDelays,

	/**
	 * Mandrill's two per-send knobs, both decided by the ROUTE.
	 *
	 * `ipPool` passes the resolved route's pool name straight through — free-form
	 * because Mandrill pool names are whatever the account created. The
	 * return-path domain is the D5 probe verdict: `relayReturnPathHost` is set
	 * only once the routing pass has PROVEN this transport honours a custom
	 * return path and the From domain's host authorises it, so no separate field
	 * (and no second probe) is needed here.
	 *
	 * The subaccount is absent on purpose — see {@link MandrillExtras}.
	 */
	buildDispatchExtras(input: DispatchExtrasInput): MandrillExtras {
		return {
			...(input.ipPool ? { ipPool: input.ipPool } : {}),
			...(input.relayReturnPathHost !== undefined
				? { returnPathDomain: input.relayReturnPathHost }
				: {}),
		};
	},

	async sendEmail(
		transport: SendTransportRecord,
		params: EmailSendParams,
		extras?: MandrillExtras
	): Promise<EmailSendAttempt> {
		let config: MandrillClientConfig;
		try {
			config = getClientConfig(transport);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			return { success: false, errorMessage, errorCode: EmailErrorCode.AUTH_FAILED };
		}

		// Compose OUTSIDE the wire timeout: composition is pure and local, so a
		// failure here is terminal and unambiguous — nothing reached Mandrill.
		let composed: ReturnType<typeof composeMessage>;
		try {
			composed = composeMessage({
				from: params.from,
				to: [params.to],
				subject: params.subject,
				html: params.html,
				text: params.text,
				replyTo: params.replyTo,
				headers:
					params.headers && Object.keys(params.headers).length > 0 ? params.headers : undefined,
				attachments: params.attachments?.map((a) => ({
					filename: a.filename,
					contentType: a.contentType ?? 'application/octet-stream',
					isInline: false,
					data: a.content,
				})),
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			return { success: false, errorMessage, errorCode: categorizeMandrillError(errorMessage) };
		}

		const ipPool = extras?.ipPool ?? config.defaultIpPool;
		const body: MandrillSendRawBody = {
			key: config.apiKey,
			raw_message: composed.raw.toString('utf-8'),
			// The envelope Mandrill should use. Taken from what the COMPOSER
			// produced rather than from `params`, so the address on the wire is the
			// same one the message headers were built around.
			to: composed.envelope.to,
			from_email: composed.envelope.from,
			// Accept-then-queue, so one slow recipient domain cannot hold the HTTP
			// call open past our deadline and manufacture a D4 ambiguity.
			async: true,
			// ── D3: every Mandrill feature that would rewrite or re-instrument our
			// MIME, off. Unconditional; see MandrillSendRawBody.
			track_opens: false,
			track_clicks: false,
			auto_html: false,
			auto_text: false,
			url_strip_qs: false,
			// One recipient per send, so this only governs whether Mandrill would
			// rewrite the To header it found in our raw message. It must not.
			preserve_recipients: false,
			...(ipPool ? { ip_pool: ipPool } : {}),
			...(config.subaccount ? { subaccount: config.subaccount } : {}),
			...(extras?.returnPathDomain ? { return_path_domain: extras.returnPathDomain } : {}),
		};

		const abort = new AbortController();
		try {
			const response = await withTimeout(
				fetch(MANDRILL_SEND_RAW_URL, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					// Mandrill convention: the key travels in the JSON body, not a
					// header. It therefore never reaches a URL or a log line.
					body: JSON.stringify(body),
					signal: abort.signal,
				}),
				MANDRILL_SEND_TIMEOUT_MS,
				MANDRILL_SEND_TIMEOUT_MESSAGE
			);

			if (!response.ok) {
				const text = await response.text().catch(() => '');
				const { surfaced, classifyText } = readApiError(text, response.status);
				const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
				return {
					success: false,
					errorMessage: withoutApiKey(surfaced, config.apiKey),
					errorCode: this.categorizeError(classifyText, response.status),
					...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
				};
			}

			return readRecipientResult((await response.json()) as unknown);
		} catch (error) {
			// Redacted for the same reason as the `!response.ok` path: a JSON parse
			// failure on a body that echoed our request would otherwise carry a
			// snippet of it — including the key — into the error message.
			const errorMessage = withoutApiKey(
				error instanceof Error ? error.message : 'Unknown error',
				config.apiKey
			);
			const errorName = error instanceof Error ? error.name : undefined;

			// D4 — NEVER blind-retry a timeout. Mandrill has no idempotency surface,
			// so a lost response may sit on top of an accepted (and delivered)
			// message. `AMBIGUOUS_TIMEOUT` is not retryable, and `acceptanceUnknown`
			// tells the governed boundary the outcome is genuinely undecided rather
			// than a definite failure.
			//
			// WHAT UNDECIDED COSTS, stated here because this is where it is created:
			// the response we lost is the one that carried the `_id`, and `_id` is
			// the only key a Mandrill webhook can be joined on (`send-raw` accepts no
			// caller correlator that its events echo back). So the `send` event
			// CANNOT resolve this particular ambiguity. `delivery/governedDispatch.ts`
			// therefore parks the Send `queued` — undecided, and still open to any
			// later evidence — and `delivery/sendCompletion.ts` ages it out at the
			// delivery deadline as `PROVIDER_ACCEPTANCE_UNCONFIRMED` rather than
			// claiming a delivery failure it cannot know about.
			if (isAmbiguousMandrillTimeout(errorName, errorMessage)) {
				return {
					success: false,
					errorMessage,
					errorCode: EmailErrorCode.AMBIGUOUS_TIMEOUT,
					acceptanceUnknown: true,
				};
			}

			return {
				success: false,
				errorMessage,
				errorCode: this.categorizeError(`${errorName ?? ''}: ${errorMessage}`),
			};
		} finally {
			// Promise.race cannot cancel its losing branch. Abort the request when
			// the deadline wins so it does not continue in the background.
			abort.abort();
		}
	},

	/**
	 * `sendReturnPathProbe` IS DELIBERATELY ABSENT (plan D5).
	 *
	 * The probe proves one thing and proves it one way: it puts a SIGNED VERP
	 * ADDRESS on the wire as the RFC5321.MailFrom and waits for the DSN, because
	 * the probe id lives in that address's LOCAL PART and our bounce server
	 * attributes a DSN only when the MAC over it verifies. `send-raw` offers
	 * `return_path_domain` — a DOMAIN. Mandrill mints the local part itself (its
	 * own `bounce-md_*` tracking mailbox, which is how it produces the bounce
	 * webhooks this kind is credited with), so our token cannot survive and no
	 * DSN we could attribute can ever come back.
	 *
	 * Declining is therefore the honest answer, and it is cheaper than the
	 * alternatives in both directions. Sending the probe anyway would manufacture
	 * a real hard bounce on the operator's Mandrill account — the number that
	 * gets an ESP account suspended — every backoff cycle, to age out
	 * `no_bounce_observed` and blame Mandrill for our own inability to express
	 * the envelope. Borrowing the SMTP adapter's wire (what the probe did before
	 * the wire became per-kind) would resolve `SMTP_RELAY_*` and file a verdict
	 * about a different transport under `transportId: 'mandrill'` — and a false
	 * `supported` there is what makes the send path stamp `return_path_domain` on
	 * real Mandrill mail.
	 *
	 * The probe settles this kind `unsupported` / `no_envelope_control` without a
	 * send. `MandrillExtras.returnPathDomain` stays wired for the day a Mandrill
	 * account is proven to hand the bounce stream back, but nothing can enable it
	 * on a guess: the routing pass only supplies `relayReturnPathHost` for a
	 * transport whose own probe reached `supported`.
	 */
	categorizeError(message: string, httpStatus?: number): EmailErrorCode {
		return categorizeMandrillError(message, httpStatus);
	},
};

// Exported for tests that need to bypass the lazy-init cache between cases.
export function _resetMandrillConfigCacheForTests(): void {
	cachedConfigs.clear();
}
