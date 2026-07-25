import { describe, expect, it } from 'vitest';
import {
	resolveSubmissionIdentity,
	SUBMISSION_DEDUPLICATION_HEADER,
	SUBMISSION_DEDUPLICATION_MAIL_PARAMETER,
	SUBMISSION_IDEMPOTENCY_HEADER,
	SUBMISSION_IDEMPOTENCY_MAIL_PARAMETER,
} from '../submissionIdentity.js';

const auth = { organizationId: 'org-1', credentialName: 'credential-1' };
const message = Buffer.from('From: sender@example.com\r\n\r\nidentical');

function resolve(options: {
	identity?: string;
	deduplication?: string;
	headers?: Array<[string, unknown]>;
	authOverride?: typeof auth;
	envelopeAddress?: string;
	messageOverride?: Buffer;
}) {
	return resolveSubmissionIdentity(
		options.authOverride ?? auth,
		{
			address: options.envelopeAddress ?? 'sender@Example.COM',
			params: {
				...(options.identity === undefined
					? {}
					: { [SUBMISSION_IDEMPOTENCY_MAIL_PARAMETER]: options.identity }),
				...(options.deduplication === undefined
					? {}
					: { [SUBMISSION_DEDUPLICATION_MAIL_PARAMETER]: options.deduplication }),
			},
		},
		new Map(options.headers ?? []),
		options.messageOverride ?? message
	);
}

function fingerprint(result: ReturnType<typeof resolveSubmissionIdentity>): string {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.message);
	return result.fingerprint;
}

describe('SMTP submission identity', () => {
	it('keeps an explicit operation identity stable while fingerprinting DATA and sender mismatches', () => {
		const first = resolve({ identity: 'transaction-1' });
		const changedData = resolve({
			identity: 'transaction-1',
			messageOverride: Buffer.from('changed'),
		});
		const otherPrincipal = resolve({
			identity: 'transaction-1',
			authOverride: { organizationId: 'org-2', credentialName: 'credential-1' },
		});
		const otherSender = resolve({
			identity: 'transaction-1',
			envelopeAddress: 'other@example.com',
		});

		expect(first).toMatchObject({ ok: true, mode: 'client' });
		expect(fingerprint(changedData)).not.toBe(fingerprint(first));
		if (!first.ok || !changedData.ok || !otherSender.ok) throw new Error('expected identities');
		expect(changedData.clientKeyFingerprint).toBe(first.clientKeyFingerprint);
		expect(changedData.requestFingerprint).not.toBe(first.requestFingerprint);
		expect(fingerprint(otherPrincipal)).not.toBe(fingerprint(first));
		expect(fingerprint(otherSender)).not.toBe(fingerprint(first));
		expect(otherSender.clientKeyFingerprint).toBe(first.clientKeyFingerprint);
		expect(otherSender.requestFingerprint).not.toBe(first.requestFingerprint);
	});

	it('accepts the header form and rejects conflicting header/envelope identities', () => {
		expect(resolve({ headers: [[SUBMISSION_IDEMPOTENCY_HEADER, 'header-1']] })).toMatchObject({
			ok: true,
			mode: 'client',
		});
		expect(
			resolve({
				identity: 'parameter-1',
				headers: [[SUBMISSION_IDEMPOTENCY_HEADER, 'header-1']],
			})
		).toMatchObject({ ok: false, message: 'Conflicting submission idempotency keys' });
	});

	it('creates a fresh identity whenever deduplication is disabled by parameter or header', () => {
		const parameterFirst = resolve({ deduplication: 'OFF' });
		const parameterSecond = resolve({ deduplication: 'OFF' });
		const header = resolve({ headers: [[SUBMISSION_DEDUPLICATION_HEADER, 'off']] });

		expect(parameterFirst).toMatchObject({ ok: true, mode: 'disabled' });
		expect(header).toMatchObject({ ok: true, mode: 'disabled' });
		expect(fingerprint(parameterFirst)).not.toBe(fingerprint(parameterSecond));
	});

	it('retains content-based retry identity when no client control is present', () => {
		const first = resolve({});
		const retry = resolve({});
		const changed = resolve({ messageOverride: Buffer.from('changed') });

		expect(retry).toEqual(first);
		expect(first).toMatchObject({ ok: true, mode: 'content' });
		expect(fingerprint(changed)).not.toBe(fingerprint(first));
	});

	it.each([
		['empty key', { identity: '' }],
		['oversized key', { identity: `a${'b'.repeat(200)}` }],
		['invalid key characters', { identity: 'has spaces' }],
		['unknown deduplication value', { deduplication: 'ON' }],
		[
			'repeated idempotency header',
			{ headers: [[SUBMISSION_IDEMPOTENCY_HEADER, ['first', 'second']]] },
		],
	] as const)('rejects %s', (_name, controls) => {
		expect(resolve(controls as Parameters<typeof resolve>[0])).toMatchObject({ ok: false });
	});
});
