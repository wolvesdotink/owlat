/**
 * MTA Send provider adapter (module).
 *
 * Per ADR-0020. Single-attempt `sendEmail` — the **Send dispatch (helper)**
 * owns the retry loop and uses `retryDelays` + `categorizeError`. The MTA's
 * `/send` endpoint accepts the body shape this module produces; failures
 * surface as `{ success: false, errorMessage, errorCode }` with the typed
 * code derived from the HTTP response.
 */

import { getOptional } from '../../env';
import {
	extractDomainOrNull,
	ROUTING_LEASE_TOKEN_MAX_LENGTH,
	type GovernedMessageType,
} from '@owlat/shared';
import {
	EmailErrorCode,
	httpStatusToErrorCode,
	type EmailSendAttempt,
	type EmailSendParams,
	type MtaExtras,
	type SendProviderModule,
} from '../types';

/**
 * Default retry schedule. The **Send dispatch (helper)** consumes this; the
 * provider does not retry internally.
 */
const MTA_RETRY_DELAYS = [1000, 5000] as const;

const MTA_TIMEOUT_MS = 30_000;
const MTA_DECISION_TIMEOUT_MS = 5_000;

export type MtaRoutingDecision =
	| { kind: 'mta'; leaseToken: string }
	| {
			kind: 'relay';
			reason: 'relay_allowed' | 'provider_breaker' | 'provider_probe_limit' | 'warmup_overflow';
	  }
	| { kind: 'defer'; retryAfterMs: number };

export async function resolveMtaRoutingDecision(input: {
	messageId: string;
	messageType: GovernedMessageType;
	organizationId: string;
	recipient: string;
	from: string;
	candidateProvider: 'mta' | 'relay';
	ipPool?: MtaExtras['ipPool'];
	allowWarmupOverflow: boolean;
}): Promise<MtaRoutingDecision> {
	const baseUrl = getOptional('MTA_API_URL');
	const apiKey = getOptional('MTA_API_KEY');
	if (!baseUrl || !apiKey) return { kind: 'defer', retryAfterMs: 60_000 };
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), MTA_DECISION_TIMEOUT_MS);
	try {
		const response = await fetch(`${baseUrl.replace(/\/$/, '')}/send/decision`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ ...input, ipPool: input.ipPool ?? 'transactional' }),
			signal: controller.signal,
		});
		if (!response.ok) return { kind: 'defer', retryAfterMs: 60_000 };
		const value = (await response.json()) as unknown;
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			return { kind: 'defer', retryAfterMs: 60_000 };
		}
		const result = value as Record<string, unknown>;
		if (result['decision'] === 'mta') {
			const lease = result['lease'];
			if (
				Object.keys(result).length === 2 &&
				typeof lease === 'object' &&
				lease !== null &&
				!Array.isArray(lease) &&
				Object.keys(lease).length === 1 &&
				typeof (lease as Record<string, unknown>)['token'] === 'string' &&
				((lease as Record<string, unknown>)['token'] as string).length > 0 &&
				((lease as Record<string, unknown>)['token'] as string).length <=
					ROUTING_LEASE_TOKEN_MAX_LENGTH
			) {
				return {
					kind: 'mta',
					leaseToken: (lease as Record<string, string>)['token']!,
				};
			}
		}
		if (
			result['decision'] === 'relay' &&
			Object.keys(result).length === 2 &&
			(result['reason'] === 'provider_breaker' ||
				result['reason'] === 'provider_probe_limit' ||
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
		if (
			result['decision'] === 'defer' &&
			Object.keys(result).length === 3 &&
			Object.keys(result).every((key) => ['decision', 'reason', 'retryAfterMs'].includes(key)) &&
			(result['reason'] === 'global_safety' ||
				result['reason'] === 'global_probe' ||
				result['reason'] === 'no_owned_ip' ||
				result['reason'] === 'lease_persistence')
		) {
			const retryAfterMs = result['retryAfterMs'];
			return {
				kind: 'defer',
				retryAfterMs:
					typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
						? Math.min(Math.max(retryAfterMs, 1_000), 60 * 60 * 1000)
						: 60_000,
			};
		}
		return { kind: 'defer', retryAfterMs: 60_000 };
	} catch {
		return { kind: 'defer', retryAfterMs: 60_000 };
	} finally {
		clearTimeout(timeout);
	}
}

export const mtaSendProvider: SendProviderModule<'mta'> = {
	kind: 'mta',
	retryDelays: MTA_RETRY_DELAYS,

	async sendEmail(params: EmailSendParams, extras?: MtaExtras): Promise<EmailSendAttempt> {
		const baseUrl = getOptional('MTA_API_URL');
		if (!baseUrl) {
			return {
				success: false,
				errorMessage: 'MTA_API_URL environment variable is not set',
				errorCode: EmailErrorCode.AUTH_FAILED,
			};
		}
		const apiKey = getOptional('MTA_API_KEY');
		if (!apiKey) {
			return {
				success: false,
				errorMessage: 'MTA_API_KEY environment variable is not set',
				errorCode: EmailErrorCode.AUTH_FAILED,
			};
		}

		const fromDomain = extractDomainOrNull(params.from) ?? '';

		const body = {
			messageId: extras?.messageId ?? crypto.randomUUID(),
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
			routingLease: extras?.routingLease,
			routingReentry: extras?.routingReentry,
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
				if (response.status === 409) {
					try {
						const parsed = JSON.parse(errorText) as Record<string, unknown>;
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
					errorCode: this.categorizeError(errorText, response.status),
					...(retryAfterMs === undefined ? {} : { retryAfterMs }),
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
