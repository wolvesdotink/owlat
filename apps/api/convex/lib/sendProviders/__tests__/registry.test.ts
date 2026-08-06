import { describe, it, expect } from 'vitest';
import {
	providerFor,
	isSendProviderKind,
	SEND_PROVIDERS,
	EmailErrorCode,
	isRetryableErrorCode,
	type SendProviderKind,
} from '../index';
import { CORE_SEND_PROVIDER_CATALOG_ENTRIES } from '@owlat/shared';
import { SEND_PROVIDER_CATALOG } from '../catalog';

describe('Send provider registry', () => {
	it('providerFor returns the module for each kind', () => {
		expect(providerFor('mta').kind).toBe('mta');
		expect(providerFor('ses').kind).toBe('ses');
		expect(providerFor('resend').kind).toBe('resend');
		expect(providerFor('smtp').kind).toBe('smtp');
		expect(providerFor('mandrill').kind).toBe('mandrill');
	});

	it('providerFor throws on unknown kinds', () => {
		expect(() => providerFor('postmark' as SendProviderKind)).toThrow(/Unknown send provider/);
	});

	it('SEND_PROVIDERS keys match the SendProviderKind union exactly', () => {
		const keys = Object.keys(SEND_PROVIDERS).sort();
		expect(keys).toEqual(['mandrill', 'mta', 'resend', 'ses', 'smtp']);
	});

	/**
	 * The fields this pin is about — "ordering, credentials, and retry behavior",
	 * plus the capability declarations the governed boundary reads.
	 *
	 * A PROJECTION rather than the whole entry since P1.1 moved the entries into
	 * `@owlat/shared`: they also carry `tier`, `optionalEnvVars`, the D5
	 * `credentialFields` descriptors and `setupProbe`, and restating a form
	 * descriptor here would be a second copy of a pin that already exists in that
	 * package's own suite (`sendProviderCatalog.test.ts`) — the exact duplication
	 * the catalog move exists to end. What THIS file owns is the COMPOSED catalog:
	 * that the five built-ins come first, in this order, with these values, before
	 * any bundled plugin entry. The identity assertion below closes the gap a
	 * projection would otherwise leave (a backend copy that drifted from the
	 * shared declaration would still project correctly).
	 */
	const PINNED_FIELDS = [
		'kind',
		'label',
		'retryDelays',
		'requiredEnvVars',
		'supportsCustomReturnPath',
		'hasProviderFeedback',
		'domainVerification',
		'acceptanceSemantics',
		'messageIdSource',
		'deduplicatesOnIdempotencyKey',
		'tagsFeedbackProvenance',
	] as const;

	function pinned(entry: (typeof SEND_PROVIDER_CATALOG)[number]): Record<string, unknown> {
		const record = entry as unknown as Record<string, unknown>;
		return Object.fromEntries(PINNED_FIELDS.map((field) => [field, record[field]]));
	}

	it('composes the shared catalog entries themselves, never a copy of them', () => {
		// The backend joins adapters to the catalog; it does not re-declare it
		// (P1.1 / D1). Reference identity is the cheapest proof that no second
		// literal crept back in.
		for (const [index, entry] of CORE_SEND_PROVIDER_CATALOG_ENTRIES.entries()) {
			expect(SEND_PROVIDER_CATALOG[index]).toBe(entry);
		}
	});

	it('pins built-in ordering, credentials, and retry behavior before plugin entries', () => {
		expect(SEND_PROVIDER_CATALOG.slice(0, 5).map(pinned)).toEqual([
			{
				kind: 'mta',
				label: 'Owlat MTA',
				retryDelays: [1_000, 5_000],
				requiredEnvVars: ['MTA_API_URL', 'MTA_API_KEY'],
				supportsCustomReturnPath: 'yes',
				hasProviderFeedback: true,
				domainVerification: 'none',
				// The two dispatch semantics the governed boundary used to spell as
				// `providerKind === 'mta'` (plan P0.1/D2). Only the own MTA takes
				// custody, and only its message id is one we minted ourselves.
				acceptanceSemantics: 'accepted',
				messageIdSource: 'idempotency-key',
				// The dedup surface the SYSTEM/AUTH mail path asks about (P0.4). Not a
				// derivation of the pair above: `resend` declares it true without taking
				// custody, and every other kind declares it false.
				deduplicatesOnIdempotencyKey: true,
				// The one transport whose feedback carries OUR provenance tag: mail
				// leaving our own infrastructure is VERP-attributed on the way out.
				tagsFeedbackProvenance: true,
			},
			{
				kind: 'ses',
				label: 'Amazon SES',
				retryDelays: [1_000, 5_000, 30_000],
				requiredEnvVars: ['AWS_SES_REGION', 'AWS_SES_ACCESS_KEY_ID', 'AWS_SES_SECRET_ACCESS_KEY'],
				supportsCustomReturnPath: 'no',
				hasProviderFeedback: true,
				domainVerification: 'api',
				acceptanceSemantics: 'unknown-on-timeout',
				messageIdSource: 'provider',
				deduplicatesOnIdempotencyKey: false,
				tagsFeedbackProvenance: false,
			},
			{
				kind: 'resend',
				label: 'Resend',
				retryDelays: [1_000, 5_000, 30_000],
				requiredEnvVars: ['RESEND_API_KEY'],
				supportsCustomReturnPath: 'no',
				hasProviderFeedback: true,
				domainVerification: 'none',
				acceptanceSemantics: 'unknown-on-timeout',
				messageIdSource: 'provider',
				// The `Idempotency-Key` header Resend threads — a dedup surface without
				// custody, which is why this is its own field.
				deduplicatesOnIdempotencyKey: true,
				tagsFeedbackProvenance: false,
			},
			{
				kind: 'smtp',
				label: 'SMTP relay',
				retryDelays: [1_000, 5_000, 30_000],
				requiredEnvVars: ['SMTP_RELAY_HOST', 'SMTP_RELAY_USERNAME', 'SMTP_RELAY_PASSWORD'],
				supportsCustomReturnPath: 'probe',
				hasProviderFeedback: false,
				domainVerification: 'none',
				acceptanceSemantics: 'unknown-on-timeout',
				// A relay assigns no id of its own — the adapter reports the
				// `Message-ID` the composer minted.
				messageIdSource: 'composed',
				deduplicatesOnIdempotencyKey: false,
				tagsFeedbackProvenance: false,
			},
			{
				kind: 'mandrill',
				label: 'Mailchimp Transactional (Mandrill)',
				retryDelays: [1_000, 5_000, 30_000],
				// The API key ONLY. The webhook key, subaccount and IP pool are
				// optional refinements, and listing them here would make the presence
				// gate report an unwebhooked deployment as unconfigured.
				requiredEnvVars: ['MANDRILL_API_KEY'],
				supportsCustomReturnPath: 'probe',
				hasProviderFeedback: true,
				// P3.1 flipped this once `domains/providers/mandrill` registered.
				domainVerification: 'api',
				acceptanceSemantics: 'unknown-on-timeout',
				messageIdSource: 'provider',
				deduplicatesOnIdempotencyKey: false,
				tagsFeedbackProvenance: false,
			},
		]);
	});

	it('declares an API-verified domain identity — the P3.1 two-sided flip', () => {
		// Declaring `domainVerification: 'api'` without the domain provider is a
		// COMPILE error (the `ApiVerifiedSendProviderKind` completeness guard in
		// `domains/providers`), so this line and `SENDING_DOMAIN_PROVIDERS.mandrill`
		// can only move together. Pinned at runtime too, from the other side:
		// `domains/providers/__tests__/registry.test.ts` asserts the registration.
		const mandrill = SEND_PROVIDER_CATALOG.find((entry) => entry.kind === 'mandrill');
		expect(mandrill?.domainVerification).toBe('api');
	});
});

describe('isSendProviderKind', () => {
	it('returns true for known kinds', () => {
		expect(isSendProviderKind('mta')).toBe(true);
		expect(isSendProviderKind('ses')).toBe(true);
		expect(isSendProviderKind('resend')).toBe(true);
		expect(isSendProviderKind('smtp')).toBe(true);
		expect(isSendProviderKind('mandrill')).toBe(true);
	});

	it('returns false for unknown / nullish kinds', () => {
		expect(isSendProviderKind('postmark')).toBe(false);
		expect(isSendProviderKind('')).toBe(false);
		expect(isSendProviderKind(undefined)).toBe(false);
		expect(isSendProviderKind(null)).toBe(false);
	});
});

describe('EmailErrorCode + isRetryableErrorCode', () => {
	it('has the seven expected codes', () => {
		expect(EmailErrorCode.RATE_LIMIT).toBe('RATE_LIMIT');
		expect(EmailErrorCode.SERVER_ERROR).toBe('SERVER_ERROR');
		expect(EmailErrorCode.INVALID_RECIPIENT).toBe('INVALID_RECIPIENT');
		expect(EmailErrorCode.INVALID_SENDER).toBe('INVALID_SENDER');
		expect(EmailErrorCode.AUTH_FAILED).toBe('AUTH_FAILED');
		expect(EmailErrorCode.CONTENT_REJECTED).toBe('CONTENT_REJECTED');
		expect(EmailErrorCode.UNKNOWN).toBe('UNKNOWN');
	});

	it('classifies retryable codes correctly', () => {
		expect(isRetryableErrorCode(EmailErrorCode.RATE_LIMIT)).toBe(true);
		expect(isRetryableErrorCode(EmailErrorCode.SERVER_ERROR)).toBe(true);
		expect(isRetryableErrorCode(EmailErrorCode.INVALID_RECIPIENT)).toBe(false);
		expect(isRetryableErrorCode(EmailErrorCode.INVALID_SENDER)).toBe(false);
		expect(isRetryableErrorCode(EmailErrorCode.AUTH_FAILED)).toBe(false);
		expect(isRetryableErrorCode(EmailErrorCode.CONTENT_REJECTED)).toBe(false);
		expect(isRetryableErrorCode(EmailErrorCode.UNKNOWN)).toBe(false);
	});
});

describe('Adapter contracts (post-Phase-2)', () => {
	it.each(['mta', 'ses', 'resend', 'smtp', 'mandrill'] as const)(
		'%s declares a non-empty retryDelays',
		(kind) => {
			expect(providerFor(kind).retryDelays.length).toBeGreaterThan(0);
		}
	);

	it.each(['mta', 'ses', 'resend', 'smtp', 'mandrill'] as const)(
		'%s categorizeError is callable',
		(kind) => {
			// Returns a code without throwing; defaults to UNKNOWN for empty input.
			expect(providerFor(kind).categorizeError('')).toBe(EmailErrorCode.UNKNOWN);
		}
	);
});
