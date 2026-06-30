import { describe, it, expect } from 'vitest';
import {
	providerFor,
	isSendProviderKind,
	SEND_PROVIDERS,
	EmailErrorCode,
	isRetryableErrorCode,
	type SendProviderKind,
} from '../index';

describe('Send provider registry', () => {
	it('providerFor returns the module for each kind', () => {
		expect(providerFor('mta').kind).toBe('mta');
		expect(providerFor('ses').kind).toBe('ses');
		expect(providerFor('resend').kind).toBe('resend');
	});

	it('providerFor throws on unknown kinds', () => {
		expect(() => providerFor('postmark' as SendProviderKind)).toThrow(/Unknown send provider/);
	});

	it('SEND_PROVIDERS keys match the SendProviderKind union exactly', () => {
		const keys = Object.keys(SEND_PROVIDERS).sort();
		expect(keys).toEqual(['mta', 'resend', 'ses']);
	});
});

describe('isSendProviderKind', () => {
	it('returns true for known kinds', () => {
		expect(isSendProviderKind('mta')).toBe(true);
		expect(isSendProviderKind('ses')).toBe(true);
		expect(isSendProviderKind('resend')).toBe(true);
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
	it.each(['mta', 'ses', 'resend'] as const)('%s declares a non-empty retryDelays', (kind) => {
		expect(providerFor(kind).retryDelays.length).toBeGreaterThan(0);
	});

	it.each(['mta', 'ses', 'resend'] as const)('%s categorizeError is callable', (kind) => {
		// Returns a code without throwing; defaults to UNKNOWN for empty input.
		expect(providerFor(kind).categorizeError('')).toBe(EmailErrorCode.UNKNOWN);
	});
});
