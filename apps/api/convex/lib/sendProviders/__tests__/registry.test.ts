import { describe, it, expect } from 'vitest';
import {
	providerFor,
	isSendProviderKind,
	SEND_PROVIDERS,
	EmailErrorCode,
	isRetryableErrorCode,
	type SendProviderKind,
} from '../index';
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

	it('pins built-in ordering, credentials, and retry behavior before plugin entries', () => {
		expect(SEND_PROVIDER_CATALOG.slice(0, 5)).toEqual([
			{
				kind: 'mta',
				label: 'Owlat MTA',
				retryDelays: [1_000, 5_000],
				requiredEnvVars: ['MTA_API_URL', 'MTA_API_KEY'],
				supportsCustomReturnPath: 'yes',
				hasProviderFeedback: true,
				domainVerification: 'none',
			},
			{
				kind: 'ses',
				label: 'Amazon SES',
				retryDelays: [1_000, 5_000, 30_000],
				requiredEnvVars: ['AWS_SES_REGION', 'AWS_SES_ACCESS_KEY_ID', 'AWS_SES_SECRET_ACCESS_KEY'],
				supportsCustomReturnPath: 'no',
				hasProviderFeedback: true,
				domainVerification: 'api',
			},
			{
				kind: 'resend',
				label: 'Resend',
				retryDelays: [1_000, 5_000, 30_000],
				requiredEnvVars: ['RESEND_API_KEY'],
				supportsCustomReturnPath: 'no',
				hasProviderFeedback: true,
				domainVerification: 'none',
			},
			{
				kind: 'smtp',
				label: 'SMTP relay',
				retryDelays: [1_000, 5_000, 30_000],
				requiredEnvVars: ['SMTP_RELAY_HOST', 'SMTP_RELAY_USERNAME', 'SMTP_RELAY_PASSWORD'],
				supportsCustomReturnPath: 'probe',
				hasProviderFeedback: false,
				domainVerification: 'none',
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
				// P3.1 flips this to 'api' when `domains/providers/mandrill` registers.
				domainVerification: 'none',
			},
		]);
	});

	it('declares no domain-identity provider yet — the P3.1 ordering constraint', () => {
		// Declaring `domainVerification: 'api'` before the domain provider exists is
		// a COMPILE error (the `ApiVerifiedSendProviderKind` completeness guard in
		// `domains/providers`). Pinned at runtime too so the flip is a deliberate
		// two-sided edit rather than something a later piece does by halves.
		const mandrill = SEND_PROVIDER_CATALOG.find((entry) => entry.kind === 'mandrill');
		expect(mandrill?.domainVerification).toBe('none');
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
