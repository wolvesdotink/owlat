'use node';

/**
 * Mailchimp Transactional (Mandrill) Send provider adapter (module).
 *
 * Per ADR-0020. The MIGRATION arm: a team arriving from Mailchimp keeps
 * sending through their existing Mandrill account while the shipped ramp
 * controller walks traffic onto Owlat's own MTA cell by cell. Mandrill is
 * therefore just another reference arm — nothing in routing, the ramp, or the
 * measurement plane knows this file exists.
 *
 * Shaped on `resend/index.ts` (the other HTTP-API ESP): a per-`transport.id`
 * config cache and one single-attempt call. The HTTP plumbing (base URL,
 * timeout, abort, error-body reading, key redaction) lives in `./client.ts`,
 * shared with the sender-domain client. Two things differ from Resend, and both
 * are decisions rather than accidents:
 *
 *  - **We send our own MIME.** Owlat's composition pipeline IS the product:
 *    first-party open/click tracking, RFC 8058 one-click unsubscribe headers,
 *    `Feedback-ID`, `List-Id`, a plain-text part derived from the UNTRACKED
 *    HTML. So this adapter composes the whole message with `@owlat/mail-message`
 *    exactly as `smtp/index.ts` does and posts it to `messages/send-raw` with
 *    every Mandrill feature that would rewrite or re-instrument it turned OFF.
 *    Mandrill `open`/`click` webhook events are ignored for the same reason: both
 *    arms must be measured on identical instrumentation or the `engagement_ratio`
 *    ramp gate is comparing two different rulers.
 *  - **A timeout is TERMINAL.** Mandrill's API has no idempotency key, so a
 *    timed-out request may or may not have been accepted. Retrying would
 *    double-deliver. The adapter only reports `AMBIGUOUS_TIMEOUT`; the catalog
 *    (`deduplicatesOnIdempotencyKey: false`, `unknown-on-timeout`) is what makes
 *    `sendProviderDispatch` return it terminal with `acceptanceUnknown`, the
 *    same outcome SES and Emailit get from the same declaration.
 *
 * This module runs on the `'use node'` delivery worker: `@owlat/mail-message`
 * composes into a Node `Buffer`.
 */

import { composeMessage } from '@owlat/mail-message';
import {
	EmailErrorCode,
	type DispatchExtrasInput,
	type EmailSendAttempt,
	type EmailSendParams,
	type MandrillExtras,
	type SendProviderModule,
} from '../types';
import { sendProviderCatalogEntry } from '../catalog';
import { toComposeInput } from '../composeInput';
import { transportEnvOptional, transportEnvRequired } from '../transportEnv';
import type { SendTransportRecord } from '../transports';
import { isAmbiguousPostDispatchTimeout } from '../errors';
import { postMandrill } from './client';
import { mandrillRejectCode, mandrillRejectSuppression } from '../../../webhooks/adapters/mandrill';
import {
	categorizeMandrillError,
	parseRetryAfterMs,
	MANDRILL_SEND_TIMEOUT_MESSAGE,
	MANDRILL_SEND_TIMEOUT_MS,
} from './errors';

export {
	categorizeMandrillError,
	parseRetryAfterMs,
	MANDRILL_SEND_TIMEOUT_MESSAGE,
	MANDRILL_SEND_TIMEOUT_MS,
} from './errors';

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
 * The feature-off flags are the executable form of that rule and are asserted
 * verbatim by `__tests__/sendRaw.test.ts`. They are sent UNCONDITIONALLY — never omitted
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
 * `providerMessageId` the webhook adapter joins on; `rejected` and
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
	// A `rejected` result is Mandrill's reject list refusing the address, the
	// same fact its `reject` webhook reports. Read through the webhook's own
	// table, so a reason suppresses here exactly when it suppresses there and a
	// sender-side reason (`unsigned`, `invalid-sender`, ...) suppresses no one.
	const suppression =
		status === 'rejected' ? mandrillRejectSuppression(mandrillRejectCode(reason)) : undefined;
	return {
		success: false,
		errorMessage: `Mandrill ${detail.trim()}`,
		errorCode: categorizeMandrillError(detail),
		...(suppression ? { suppression } : {}),
	};
}

export const mandrillSendProvider: SendProviderModule<'mandrill'> = {
	kind: 'mandrill',
	retryDelays: sendProviderCatalogEntry('mandrill').retryDelays,

	/**
	 * Mandrill's two per-send knobs, both decided by the ROUTE.
	 *
	 * `ipPool` passes the resolved route's pool name straight through — free-form
	 * because Mandrill pool names are whatever the account created. The
	 * return-path domain is the probe verdict: `relayReturnPathHost` is set
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
			composed = composeMessage(toComposeInput(params));
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
			// call open past our deadline and manufacture an ambiguous outcome.
			async: true,
			// ── Every Mandrill feature that would rewrite or re-instrument our MIME,
			// off. Unconditional; see MandrillSendRawBody.
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

		try {
			// The key travels in the JSON body (Mandrill convention); `postMandrill`
			// redacts it from every error it returns or throws.
			const result = await postMandrill('/messages/send-raw', body, {
				timeoutMs: MANDRILL_SEND_TIMEOUT_MS,
				timeoutMessage: MANDRILL_SEND_TIMEOUT_MESSAGE,
				failureLabel: 'Mandrill send failed',
			});

			if (!result.ok) {
				const retryAfterMs = parseRetryAfterMs(result.retryAfter);
				return {
					success: false,
					errorMessage: result.error.surfaced,
					errorCode: this.categorizeError(result.error.classifyText, result.status),
					...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
				};
			}

			return readRecipientResult(result.payload);
		} catch (error) {
			// Already redacted by `postMandrill`, including a JSON parse failure on
			// a body that echoed our request.
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			const errorName = error instanceof Error ? error.name : undefined;

			// NEVER blind-retry a timeout. Mandrill has no idempotency surface,
			// so a lost response may sit on top of an accepted (and delivered)
			// message. Report `AMBIGUOUS_TIMEOUT`; `sendProviderDispatch` reads the
			// catalog, returns it terminal and adds `acceptanceUnknown`, which tells
			// the governed boundary the outcome is undecided rather than a definite
			// failure.
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
			if (isAmbiguousPostDispatchTimeout(errorName, errorMessage, MANDRILL_SEND_TIMEOUT_MESSAGE)) {
				return {
					success: false,
					errorMessage,
					errorCode: EmailErrorCode.AMBIGUOUS_TIMEOUT,
				};
			}

			return {
				success: false,
				errorMessage,
				errorCode: this.categorizeError(`${errorName ?? ''}: ${errorMessage}`),
			};
		}
	},

	/**
	 * `sendReturnPathProbe` IS DELIBERATELY ABSENT.
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
