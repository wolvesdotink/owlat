/** Client-controlled SMTP submission identity and per-recipient job IDs. */

import { createHash, randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';

export const SUBMISSION_IDEMPOTENCY_HEADER = 'x-owlat-idempotency-key';
export const SUBMISSION_DEDUPLICATION_HEADER = 'x-owlat-deduplication';
export const SUBMISSION_IDEMPOTENCY_MAIL_PARAMETER = 'XOWLATID';
export const SUBMISSION_DEDUPLICATION_MAIL_PARAMETER = 'XOWLATDEDUP';

const CLIENT_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:+-]{0,199}$/;

interface SubmissionPrincipal {
	organizationId: string;
	credentialName: string;
	postbox?: {
		mailboxId: string;
		appPasswordId: string;
	};
}

interface SubmissionEnvelope {
	address: string;
	params?: Readonly<Record<string, string>>;
}

interface SubmissionHeaders {
	get(name: string): unknown;
}

export interface ResolvedSubmissionIdentity {
	readonly ok: true;
	/** Stable operation identity used to derive independent recipient job IDs. */
	readonly fingerprint: string;
	/** Principal-scoped explicit key identity used only for request binding. */
	readonly clientKeyFingerprint?: string;
	/** Canonical request content bound to an explicit client operation identity. */
	readonly requestFingerprint: string;
	readonly mode: 'client' | 'content' | 'disabled';
}

export type SubmissionIdentityResult =
	| ResolvedSubmissionIdentity
	| { readonly ok: false; readonly message: string };

const BIND_CLIENT_REQUEST_LUA = `
local existing = redis.call('GET', KEYS[1])
if not existing then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
if existing == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 0
end
return -1
`;

export function normalizeEnvelopeAddress(address: string): string {
	const trimmed = address.trim();
	const separator = trimmed.lastIndexOf('@');
	if (separator < 0) return trimmed;
	return `${trimmed.slice(0, separator)}@${trimmed.slice(separator + 1).toLowerCase()}`;
}

/**
 * Resolve one submission identity, scoped to the authenticated principal and
 * envelope sender. A client key is stable across uncertain retries; disabling
 * deduplication creates a fresh identity for this DATA transaction.
 */
export function resolveSubmissionIdentity(
	auth: SubmissionPrincipal,
	envelope: SubmissionEnvelope,
	headers: SubmissionHeaders,
	message: Buffer
): SubmissionIdentityResult {
	const parameterIdentity = envelope.params?.[SUBMISSION_IDEMPOTENCY_MAIL_PARAMETER]?.trim();
	const headerIdentity = textHeader(headers, SUBMISSION_IDEMPOTENCY_HEADER);
	if (parameterIdentity && headerIdentity && parameterIdentity !== headerIdentity) {
		return { ok: false, message: 'Conflicting submission idempotency keys' };
	}
	const clientIdentity = parameterIdentity ?? headerIdentity;
	if (
		(parameterIdentity !== undefined || headerIdentity !== undefined) &&
		(!clientIdentity || !CLIENT_IDENTITY_PATTERN.test(clientIdentity))
	) {
		return { ok: false, message: 'Invalid submission idempotency key' };
	}

	const parameterDeduplication = envelope.params?.[SUBMISSION_DEDUPLICATION_MAIL_PARAMETER]?.trim();
	const headerDeduplication = textHeader(headers, SUBMISSION_DEDUPLICATION_HEADER);
	for (const value of [parameterDeduplication, headerDeduplication]) {
		if (value !== undefined && value.toLowerCase() !== 'off') {
			return { ok: false, message: 'Submission deduplication must be OFF when specified' };
		}
	}
	const deduplicationDisabled =
		parameterDeduplication !== undefined || headerDeduplication !== undefined;
	if (clientIdentity && deduplicationDisabled) {
		return { ok: false, message: 'Idempotency key conflicts with disabled deduplication' };
	}

	const identity = clientIdentity
		? { kind: 'client' as const, value: clientIdentity }
		: deduplicationDisabled
			? { kind: 'disabled' as const, value: randomUUID() }
			: {
					kind: 'content' as const,
					value: createHash('sha256').update(message).digest('hex'),
				};
	const principal = auth.postbox
		? {
				kind: 'postbox',
				organizationId: auth.organizationId,
				mailboxId: auth.postbox.mailboxId,
				appPasswordId: auth.postbox.appPasswordId,
			}
		: {
				kind: 'credential',
				organizationId: auth.organizationId,
				credentialName: auth.credentialName,
			};
	const envelopeFrom = normalizeEnvelopeAddress(envelope.address);
	const dataSha256 = createHash('sha256').update(message).digest('hex');
	const requestFingerprint = hashCanonicalValue({ principal, envelopeFrom, dataSha256 });
	const clientKeyFingerprint =
		identity.kind === 'client'
			? hashCanonicalValue({ principal, clientIdentity: identity.value })
			: undefined;
	const operation =
		identity.kind === 'client'
			? { clientKeyFingerprint, requestFingerprint }
			: { principal, envelopeFrom, identity };
	const fingerprint = hashCanonicalValue(operation);
	return {
		ok: true,
		fingerprint,
		requestFingerprint,
		mode: identity.kind,
		...(clientKeyFingerprint ? { clientKeyFingerprint } : {}),
	};
}

/**
 * Atomically bind an explicit client key to its first canonical request.
 * Recipient envelopes are intentionally absent from the request fingerprint,
 * so a partial fan-out can retry a reordered or reduced recipient subset.
 */
export async function bindSubmissionClientRequest(
	redis: Redis,
	identity: ResolvedSubmissionIdentity
): Promise<'not-client' | 'bound' | 'matching' | 'conflict'> {
	if (identity.mode !== 'client') return 'not-client';
	if (!identity.clientKeyFingerprint) {
		throw new Error('Client submission identity is missing its key fingerprint');
	}
	const status = Number(
		await redis.eval(
			BIND_CLIENT_REQUEST_LUA,
			1,
			`mta:submission-idempotency:{${identity.clientKeyFingerprint}}`,
			identity.requestFingerprint,
			String(GOVERNED_MTA_MAX_MESSAGE_AGE_MS)
		)
	);
	if (status === 1) return 'bound';
	if (status === 0) return 'matching';
	if (status === -1) return 'conflict';
	throw new Error('Submission idempotency binding returned an invalid status');
}

function hashCanonicalValue(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Derive each recipient independently so a retry can reorder or reduce its
 * envelope while reconciling jobs that were already accepted.
 */
export function submissionRecipientJobId(
	prefix: string,
	fingerprint: string,
	recipient: string
): string {
	const recipientDigest = createHash('sha256')
		.update(JSON.stringify([fingerprint, recipient]))
		.digest('hex');
	return `${prefix}-${recipientDigest}`;
}

function textHeader(headers: SubmissionHeaders, name: string): string | undefined {
	const value = headers.get(name);
	if (value === undefined || value === null) return undefined;
	return typeof value === 'string' ? value.trim() : '';
}
