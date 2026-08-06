/**
 * MTA Send provider adapter (module).
 *
 * Per ADR-0020. Single-attempt `sendEmail` — the **Send dispatch (helper)**
 * owns the retry loop and uses `retryDelays` + `categorizeError`. The MTA's
 * `/send` endpoint accepts the body shape this module produces; failures
 * surface as `{ success: false, errorMessage, errorCode }` with the typed
 * code derived from the HTTP response.
 */

import {
	extractDomainOrNull,
	ROUTING_LEASE_TOKEN_MAX_LENGTH,
	type DeliveryDomain,
	type GovernedMessageType,
} from '@owlat/shared';
import {
	EmailErrorCode,
	httpStatusToErrorCode,
	type DispatchExtrasInput,
	type EmailSendAttempt,
	type EmailSendParams,
	type MtaExtras,
	type MtaIpPool,
	type SendProviderModule,
	type SystemMailExtrasInput,
} from '../types';
import { transportEnvOptional } from '../transportEnv';
import { sendTransportEnvName, type SendTransportRecord } from '../transports';

/**
 * Default retry schedule. The **Send dispatch (helper)** consumes this; the
 * provider does not retry internally.
 */
const MTA_RETRY_DELAYS = [1000, 5000] as const;

const MTA_TIMEOUT_MS = 30_000;
const MTA_DECISION_TIMEOUT_MS = 5_000;

export type MtaRoutingDecision =
	| { kind: 'mta'; leaseToken: string; isProviderProbe: boolean; isGlobalProbe: boolean }
	| {
			kind: 'relay';
			reason:
				| 'relay_allowed'
				| 'provider_breaker'
				| 'provider_probe_limit'
				| 'provider_hysteresis'
				| 'warmup_overflow';
	  }
	| {
			kind: 'defer';
			retryAfterMs: number;
			/**
			 * WHO DECIDED TO DEFER — the MTA's routing governance, or a fault on our
			 * own side. Both shapes are `defer` to the caller (the message waits
			 * either way), but only `governed` is a statement about whether this
			 * sending identity may send. An unconfigured, unreachable, slow or
			 * malformed decision endpoint is `local`, and so is an ANSWER that
			 * reports our own infrastructure failing rather than the identity's
			 * standing (`MTA_DEFER_REASON_ORIGIN`) — the receiver saw neither.
			 * `delivery/deferralOutcome.ts` counts the first and skips the second, so
			 * an outage on our side cannot halt a cell for a fortnight.
			 */
			origin: 'governed' | 'local';
	  };

/**
 * EVERY defer reason the MTA may answer, each paired with WHOSE FAULT IT IS.
 *
 * One table, two jobs, so the accept-list and the classification cannot drift
 * apart: a reason absent here is an answer we did not understand and falls
 * through to the unrecognised-body return, and a reason added here cannot be
 * added without naming an origin.
 *
 * `governed` is the MTA declining this SENDING IDENTITY — an open global safety
 * circuit, a probe budget, no warmed IP to send from. `lease_persistence` is
 * none of those: it is ANY REDIS FAILURE WHILE TAKING THE LEASE — reserving a
 * half-open probe, writing the lease record, whatever the one catch in
 * `apps/mta/src/routes/routingDecision.ts` covers — so it is our own storage
 * layer failing and no receiver ever refused the mail. Gate 2 halts a cell at
 * 25% of `governed` deferrals; a Redis outage on our own MTA must not be able to
 * spend that budget.
 *
 * Exported so the adapter's own suite can assert its case list covers every key
 * — the drift this table exists to stop is a reason added here and nowhere else.
 */
export const MTA_DEFER_REASON_ORIGIN = {
	global_safety: 'governed',
	global_probe: 'governed',
	no_owned_ip: 'governed',
	lease_persistence: 'local',
} as const satisfies Record<string, 'governed' | 'local'>;

type MtaDeferReason = keyof typeof MTA_DEFER_REASON_ORIGIN;

function deferReasonOrigin(reason: unknown): 'governed' | 'local' | undefined {
	if (typeof reason !== 'string') return undefined;
	if (!Object.prototype.hasOwnProperty.call(MTA_DEFER_REASON_ORIGIN, reason)) return undefined;
	return MTA_DEFER_REASON_ORIGIN[reason as MtaDeferReason];
}

/**
 * Take a last-mile routing lease from ONE configured MTA transport.
 *
 * `transport` names WHICH one, for the same reason `sendEmail` takes it: a
 * lease is granted by the MTA that will be asked to honour it, so taking it
 * from the default instance and then presenting it to `mta#secondary` would be
 * presenting one server's decision to another. The caller passes the transport
 * it is about to send through.
 */
export async function resolveMtaRoutingDecision(
	transport: SendTransportRecord,
	input: {
		messageId: string;
		workAttemptId: string;
		routingReentryToken: string;
		startedAt: number;
		deliveryDomain: DeliveryDomain;
		messageType: GovernedMessageType;
		organizationId: string;
		recipient: string;
		from: string;
		candidateProvider: 'mta' | 'relay';
		ipPool?: MtaExtras['ipPool'];
		allowWarmupOverflow: boolean;
		requireProviderProbe?: boolean;
	}
): Promise<MtaRoutingDecision> {
	const baseUrl = transportEnvOptional(transport, 'MTA_API_URL');
	const apiKey = transportEnvOptional(transport, 'MTA_API_KEY');
	if (!baseUrl || !apiKey) return { kind: 'defer', retryAfterMs: 60_000, origin: 'local' };
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), MTA_DECISION_TIMEOUT_MS);
	try {
		const response = await fetch(`${baseUrl.replace(/\/$/, '')}/send/decision`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ ...input, ipPool: input.ipPool ?? 'transactional' }),
			signal: controller.signal,
		});
		if (!response.ok) return { kind: 'defer', retryAfterMs: 60_000, origin: 'local' };
		const value = (await response.json()) as unknown;
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			return { kind: 'defer', retryAfterMs: 60_000, origin: 'local' };
		}
		const result = value as Record<string, unknown>;
		if (result['decision'] === 'mta') {
			const lease = result['lease'];
			if (
				Object.keys(result).length === 2 &&
				typeof lease === 'object' &&
				lease !== null &&
				!Array.isArray(lease) &&
				Object.keys(lease).length === 3 &&
				typeof (lease as Record<string, unknown>)['token'] === 'string' &&
				((lease as Record<string, unknown>)['token'] as string).length > 0 &&
				((lease as Record<string, unknown>)['token'] as string).length <=
					ROUTING_LEASE_TOKEN_MAX_LENGTH &&
				typeof (lease as Record<string, unknown>)['providerProbe'] === 'boolean' &&
				typeof (lease as Record<string, unknown>)['globalProbe'] === 'boolean'
			) {
				return {
					kind: 'mta',
					leaseToken: (lease as Record<string, string>)['token']!,
					isProviderProbe: (lease as Record<string, boolean>)['providerProbe']!,
					isGlobalProbe: (lease as Record<string, boolean>)['globalProbe']!,
				};
			}
		}
		if (
			result['decision'] === 'relay' &&
			Object.keys(result).length === 2 &&
			(result['reason'] === 'provider_breaker' ||
				result['reason'] === 'provider_probe_limit' ||
				result['reason'] === 'provider_hysteresis' ||
				result['reason'] === 'warmup_overflow')
		) {
			return { kind: 'relay', reason: result['reason'] };
		}
		if (
			result['decision'] === 'relay' &&
			Object.keys(result).length === 1 &&
			input.candidateProvider === 'relay'
		) {
			return { kind: 'relay', reason: 'relay_allowed' };
		}
		const deferOrigin = deferReasonOrigin(result['reason']);
		if (
			result['decision'] === 'defer' &&
			Object.keys(result).length === 3 &&
			Object.keys(result).every((key) => ['decision', 'reason', 'retryAfterMs'].includes(key)) &&
			deferOrigin !== undefined
		) {
			const retryAfterMs = result['retryAfterMs'];
			// AN ANSWER THE MTA ITSELF GAVE, which is not the same as an answer ABOUT
			// THIS IDENTITY: the reason decides that, and only its `governed` half is
			// the defer shape gate 2 may count. Honour the delay either way — the
			// message waits the same amount of time whoever is at fault.
			return {
				kind: 'defer',
				origin: deferOrigin,
				retryAfterMs:
					typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
						? Math.min(Math.max(retryAfterMs, 1_000), 60 * 60 * 1000)
						: 60_000,
			};
		}
		// THE UNRECOGNISED ANSWER, deliberately beside the malformed-body and
		// timeout cases: a body we cannot fully validate is a body we did not
		// understand, and an answer we did not understand is not an observation
		// about this identity. A NEW DEFER REASON ON THE MTA SIDE THEREFORE LANDS
		// HERE AND STOPS BEING COUNTED until it is added to
		// `MTA_DEFER_REASON_ORIGIN` with an origin beside it — the two sides change
		// together, which is the safe direction (a reason nobody vouched for cannot
		// halt a cell) but never a silent one.
		return { kind: 'defer', retryAfterMs: 60_000, origin: 'local' };
	} catch {
		return { kind: 'defer', retryAfterMs: 60_000, origin: 'local' };
	} finally {
		clearTimeout(timeout);
	}
}

export const mtaSendProvider: SendProviderModule<'mta'> = {
	kind: 'mta',
	retryDelays: MTA_RETRY_DELAYS,

	/**
	 * The governed last mile's per-send extras.
	 *
	 * The owned MTA is the only transport that takes the full governance packet:
	 * the work identity it deduplicates on, the re-entry material its callback
	 * echoes back, and the authenticated lease it revalidates immediately before
	 * enqueue. Everything here is carried, never re-derived — the re-entry
	 * `retryState` in particular must stay byte-identical to the issued snapshot
	 * or the callback digest stops matching.
	 */
	buildDispatchExtras(input: DispatchExtrasInput): MtaExtras {
		return {
			messageId: input.idempotencyKey,
			workAttemptId: input.workAttemptId,
			routingReentryToken: input.routingReentryToken,
			routingReentry: input.routingReentry,
			organizationId: input.organizationId,
			messageType: input.messageType,
			deliveryDomain: input.deliveryDomain,
			routingLease: input.routingLease,
			// Only a campaign may spend warm-up overflow: transactional mail is not
			// what a warming schedule is pacing, so the route's permission alone
			// never grants it.
			allowWarmupOverflow: Boolean(input.messageType === 'campaign' && input.warmupOverflowEnabled),
			...(input.ipPool ? { ipPool: input.ipPool as MtaIpPool } : {}),
			// Omitted, never zeroed, when the recipient has no score: the MTA reads
			// absence as "unknown" and applies its DEFAULT band, whereas 0 would
			// order the message behind every cold contact.
			...(input.engagementScore !== undefined ? { engagementScore: input.engagementScore } : {}),
		};
	},

	/**
	 * The SYSTEM/AUTH mail intake — password reset, invitation, double opt-in.
	 *
	 * Three constants and one fact. `intakePath: 'system'` and `organizationId:
	 * 'system'` are what make this a fixed-scope `/send/system` post rather than a
	 * governed campaign send, and `ipPool: 'transactional'` is the pool auth mail
	 * belongs in — none of them is a routing decision, which is exactly why they
	 * are the MTA's business and not the caller's. The fact is the caller's
	 * idempotency key, carried as the MTA's `messageId` because that is the id its
	 * intake dedups on (`deduplicatesOnIdempotencyKey: true` in the catalog is the
	 * same statement, read by the retry-disposition rule). Absent ⇒ omitted, and
	 * the MTA mints a random one.
	 *
	 * Lifted verbatim out of `systemMail.ts`'s `if (provider === 'mta')` arm, so
	 * the /send/system body is byte-for-byte what it has always been.
	 */
	buildSystemMailExtras(input: SystemMailExtrasInput): MtaExtras {
		return {
			ipPool: 'transactional',
			organizationId: 'system',
			intakePath: 'system',
			...(input.idempotencyKey ? { messageId: input.idempotencyKey } : {}),
		};
	},

	async sendEmail(
		transport: SendTransportRecord,
		params: EmailSendParams,
		extras?: MtaExtras
	): Promise<EmailSendAttempt> {
		const baseUrl = transportEnvOptional(transport, 'MTA_API_URL');
		if (!baseUrl) {
			return {
				success: false,
				errorMessage: `${sendTransportEnvName('MTA_API_URL', transport.instanceKey)} environment variable is not set`,
				errorCode: EmailErrorCode.AUTH_FAILED,
			};
		}
		const apiKey = transportEnvOptional(transport, 'MTA_API_KEY');
		if (!apiKey) {
			return {
				success: false,
				errorMessage: `${sendTransportEnvName('MTA_API_KEY', transport.instanceKey)} environment variable is not set`,
				errorCode: EmailErrorCode.AUTH_FAILED,
			};
		}

		const fromDomain = extractDomainOrNull(params.from) ?? '';

		const body = {
			messageId: extras?.messageId ?? crypto.randomUUID(),
			workAttemptId: extras?.workAttemptId,
			routingReentryToken: extras?.routingReentryToken,
			routingReentry: extras?.routingReentry,
			to: params.to,
			from: params.from,
			subject: params.subject,
			html: params.html,
			text: params.text,
			replyTo: params.replyTo,
			headers: params.headers,
			ipPool: extras?.ipPool ?? 'transactional',
			engagementScore: extras?.engagementScore,
			dkimDomain: extras?.dkimDomain ?? fromDomain,
			organizationId: extras?.organizationId,
			messageType: extras?.messageType,
			deliveryDomain: extras?.deliveryDomain,
			routingLease: extras?.routingLease,
			allowWarmupOverflow: extras?.allowWarmupOverflow,
		};

		const normalizedUrl = baseUrl.replace(/\/$/, '');
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), MTA_TIMEOUT_MS);

		try {
			const endpoint = extras?.intakePath === 'system' ? '/send/system' : '/send';
			const response = await fetch(`${normalizedUrl}${endpoint}`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});

			if (!response.ok) {
				const errorText = await response.text().catch(() => 'Unknown error');
				let retryAfterMs: number | undefined;
				let intakePending = false;
				if (response.status === 409) {
					try {
						const parsed = JSON.parse(errorText) as Record<string, unknown>;
						intakePending = parsed['code'] === 'INTAKE_PENDING';
						if (typeof parsed['retryAfterMs'] === 'number') {
							retryAfterMs = Math.min(Math.max(parsed['retryAfterMs'], 1_000), 3_600_000);
						}
					} catch {
						// The categorizer still handles a non-JSON 409 conservatively.
					}
				}
				return {
					success: false,
					errorMessage: errorText,
					errorCode: intakePending
						? EmailErrorCode.SERVER_ERROR
						: this.categorizeError(errorText, response.status),
					...(retryAfterMs === undefined ? {} : { retryAfterMs }),
					...(intakePending ? { acceptanceUnknown: true as const } : {}),
				};
			}

			const result = (await response.json()) as { success: boolean; id?: string; error?: string };

			if (result.success && result.id) {
				return { success: true, id: result.id };
			}

			const errorText = result.error ?? 'MTA returned unsuccessful response';
			return {
				success: false,
				errorMessage: errorText,
				errorCode: this.categorizeError(errorText, response.status),
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			return {
				success: false,
				errorMessage,
				errorCode: this.categorizeError(errorMessage),
				acceptanceUnknown: true,
			};
		} finally {
			clearTimeout(timeout);
		}
	},

	/**
	 * Classify an MTA error response into a typed `EmailErrorCode`.
	 *
	 * MTA returns standard HTTP status codes plus a free-text body. Map by
	 * status code first (cheapest, most reliable), then fall back to
	 * substring matching on the body for the cases the MTA returns 200/4xx
	 * with a typed JSON `error` field.
	 */
	categorizeError(message: string, httpStatus?: number): EmailErrorCode {
		if (
			httpStatus === 409 &&
			(message.includes('ROUTING_DECISION_') || message.includes('GLOBAL_SAFETY_DEFER'))
		) {
			// The MTA revalidates the authoritative lease immediately before
			// enqueue. A breaker/IP-generation race must return to the worker so a
			// fresh decision is resolved; it is not a permanent content failure.
			return EmailErrorCode.ROUTING_DEFERRED;
		}
		if (httpStatus !== undefined) {
			const byStatus = httpStatusToErrorCode(httpStatus);
			if (byStatus !== undefined) return byStatus;
		}

		const lower = message.toLowerCase();

		if (lower.includes('abort') || lower.includes('timeout') || lower.includes('econnrefused')) {
			return EmailErrorCode.SERVER_ERROR;
		}
		if (lower.includes('rate') || lower.includes('too many')) {
			return EmailErrorCode.RATE_LIMIT;
		}
		if (
			lower.includes('invalid') &&
			(lower.includes('recipient') || lower.includes('to address'))
		) {
			return EmailErrorCode.INVALID_RECIPIENT;
		}
		if (
			lower.includes('dkim') ||
			(lower.includes('domain') && lower.includes('not')) ||
			lower.includes('sender') ||
			lower.includes('from address')
		) {
			return EmailErrorCode.INVALID_SENDER;
		}
		if (lower.includes('auth') || lower.includes('api key') || lower.includes('credential')) {
			return EmailErrorCode.AUTH_FAILED;
		}
		if (lower.includes('spam') || lower.includes('blocked') || lower.includes('rejected')) {
			return EmailErrorCode.CONTENT_REJECTED;
		}

		return EmailErrorCode.UNKNOWN;
	},
};
