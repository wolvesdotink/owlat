import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROUTING_LEASE_UNREADABLE_CODE } from '@owlat/shared';
import { mtaSendProvider } from '../mta';
import { decodeMtaRefusal, mtaConflictOf } from '../mta/refusal';
import { resolveSendTransport } from '../transports';
import { EmailErrorCode } from '../types';

const refusal = (body: Record<string, unknown>) => JSON.stringify(body);

describe('decodeMtaRefusal', () => {
	it('reads the code and the retry hint off a refusal body', () => {
		expect(
			decodeMtaRefusal(refusal({ error: 'pending', code: 'INTAKE_PENDING', retryAfterMs: 1000 }))
		).toEqual({ code: 'INTAKE_PENDING', retryAfterMs: 1000 });
	});

	it.each([
		['plain text', 'Conflict'],
		['a JSON scalar', '409'],
		['JSON null', 'null'],
		['a JSON array', '["ROUTING_DECISION_EXPIRED"]'],
		['truncated JSON', '{"code":"ROUTING_DECISION_EXP'],
	])('decodes %s to an empty refusal', (_label, body) => {
		expect(decodeMtaRefusal(body)).toEqual({});
	});

	it('drops a code that is not spelled like one', () => {
		expect(decodeMtaRefusal(refusal({ code: 'routing decision expired' }))).toEqual({});
		expect(decodeMtaRefusal(refusal({ code: 42 }))).toEqual({});
	});
});

describe('mtaConflictOf', () => {
	it.each([
		'ROUTING_DECISION_EXPIRED',
		'ROUTING_DECISION_CHANGED',
		'GLOBAL_SAFETY_DEFER',
		// A code a newer MTA build answers and this reader has never seen.
		'ROUTING_DECISION_POOL_DRAINED',
	])('reads %s as a deferral that resolves a fresh decision', (code) => {
		expect(mtaConflictOf(refusal({ error: 'resolve again', code }))).toBe('decision_deferred');
	});

	it('keeps an unreadable lease apart from a governed deferral', () => {
		expect(
			mtaConflictOf(refusal({ error: 'resolve again', code: ROUTING_LEASE_UNREADABLE_CODE }))
		).toBe('lease_unreadable');
	});

	it('reads the code, not the prose beside it', () => {
		// The person-readable text quotes a routing code; the code says otherwise.
		expect(
			mtaConflictOf(
				refusal({
					error: 'ROUTING_DECISION_EXPIRED earlier; lease now required',
					code: 'ROUTING_LEASE_REQUIRED',
				})
			)
		).toBe('refused');
		expect(
			mtaConflictOf(
				refusal({
					error: `not ${ROUTING_LEASE_UNREADABLE_CODE}`,
					code: 'ROUTING_DECISION_CHANGED',
				})
			)
		).toBe('decision_deferred');
		expect(mtaConflictOf(refusal({ error: 'GLOBAL_SAFETY_DEFER', code: 'INTAKE_PENDING' }))).toBe(
			'intake_pending'
		);
	});

	it('answers every decoded code, known or not', () => {
		expect(mtaConflictOf(refusal({ code: 'ROUTING_LEASE_REQUIRED' }))).toBe('refused');
		// A code a newer MTA build answers that is not a routing refusal.
		expect(mtaConflictOf(refusal({ error: 'Duplicate request', code: 'INTAKE_DUPLICATE' }))).toBe(
			'refused'
		);
	});

	it('still defers a body that carries no code but names one', () => {
		expect(mtaConflictOf('ROUTING_DECISION_EXPIRED')).toBe('decision_deferred');
		expect(mtaConflictOf(refusal({ error: 'GLOBAL_SAFETY_DEFER' }))).toBe('decision_deferred');
		expect(
			mtaConflictOf(
				`${ROUTING_LEASE_UNREADABLE_CODE} while ROUTING_DECISION_EXPIRED was being checked`
			)
		).toBe('lease_unreadable');
	});

	it('finds nothing in a body with neither code nor token', () => {
		expect(mtaConflictOf('Conflict')).toBeUndefined();
		expect(mtaConflictOf(refusal({ error: 'Duplicate request' }))).toBeUndefined();
	});
});

describe('mtaSendProvider.categorizeError on a 409', () => {
	it('maps the decoded routing refusal to its error code', () => {
		expect(
			mtaSendProvider.categorizeError(refusal({ code: 'ROUTING_DECISION_POOL_DRAINED' }), 409)
		).toBe(EmailErrorCode.ROUTING_DEFERRED);
		expect(
			mtaSendProvider.categorizeError(refusal({ code: ROUTING_LEASE_UNREADABLE_CODE }), 409)
		).toBe(EmailErrorCode.ROUTING_LEASE_UNREADABLE);
	});

	it('does not defer a coded refusal whose prose quotes a routing code', () => {
		expect(
			mtaSendProvider.categorizeError(
				refusal({ error: 'ROUTING_DECISION_EXPIRED', code: 'ROUTING_LEASE_REQUIRED' }),
				409
			)
		).toBe(EmailErrorCode.UNKNOWN);
	});

	it.each([
		['the MTA wording', 'A current routing lease is required'],
		['a timeout', 'timeout while waiting for the lease'],
		['an invalid sender', 'DKIM domain not verified for sender'],
		['rate limiting', 'too many requests, rate limited'],
		['a routing token', 'ROUTING_DECISION_EXPIRED'],
		['a pending intake', 'INTAKE_PENDING'],
		['nothing', undefined],
	])('classifies a coded refusal by its code whatever the prose says (%s)', (_label, error) => {
		expect(
			mtaSendProvider.categorizeError(refusal({ error, code: 'ROUTING_LEASE_REQUIRED' }), 409)
		).toBe(EmailErrorCode.UNKNOWN);
		expect(
			mtaSendProvider.categorizeError(refusal({ error, code: 'ROUTING_DECISION_CHANGED' }), 409)
		).toBe(EmailErrorCode.ROUTING_DEFERRED);
		expect(
			mtaSendProvider.categorizeError(refusal({ error, code: ROUTING_LEASE_UNREADABLE_CODE }), 409)
		).toBe(EmailErrorCode.ROUTING_LEASE_UNREADABLE);
		expect(mtaSendProvider.categorizeError(refusal({ error, code: 'INTAKE_PENDING' }), 409)).toBe(
			EmailErrorCode.SERVER_ERROR
		);
	});

	it('reads the prose of a codeless 409 as it always has', () => {
		expect(mtaSendProvider.categorizeError(refusal({ error: 'Request timeout' }), 409)).toBe(
			EmailErrorCode.SERVER_ERROR
		);
		expect(mtaSendProvider.categorizeError('Conflict', 409)).toBe(EmailErrorCode.UNKNOWN);
	});

	it('reads routing codes only on a 409', () => {
		expect(
			mtaSendProvider.categorizeError(refusal({ code: 'ROUTING_DECISION_EXPIRED' }), 400)
		).toBe(EmailErrorCode.UNKNOWN);
	});
});

describe('mtaSendProvider.sendEmail on a 409', () => {
	const originalFetch = global.fetch;
	beforeEach(() => {
		vi.stubEnv('MTA_API_URL', 'https://mta.test');
		vi.stubEnv('MTA_API_KEY', 'test-key');
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		global.fetch = originalFetch;
	});

	async function sendAgainst(body: string) {
		global.fetch = vi.fn().mockResolvedValue(new Response(body, { status: 409 }));
		return await mtaSendProvider.sendEmail(resolveSendTransport('mta'), {
			to: 'recipient@example.com',
			from: 'sender@mail.example.org',
			subject: 'refused',
			html: '<p>refused</p>',
		});
	}

	it('reads a pending intake off the code only', async () => {
		const pending = await sendAgainst(
			refusal({ error: 'pending', code: 'INTAKE_PENDING', retryAfterMs: 5_000 })
		);
		expect(pending).toMatchObject({ acceptanceUnknown: true, retryAfterMs: 5_000 });

		// The prose says pending; the answer is a routing deferral.
		const routed = await sendAgainst(
			refusal({ error: 'INTAKE_PENDING', code: 'ROUTING_DECISION_EXPIRED' })
		);
		expect(routed).not.toHaveProperty('acceptanceUnknown');
		expect(routed).toMatchObject({ errorCode: EmailErrorCode.ROUTING_DEFERRED });
	});

	it('treats a non-JSON 409 as an ordinary refusal', async () => {
		const attempt = await sendAgainst('Conflict');
		expect(attempt).toMatchObject({ success: false, errorCode: EmailErrorCode.UNKNOWN });
		expect(attempt).not.toHaveProperty('acceptanceUnknown');
		expect(attempt).not.toHaveProperty('retryAfterMs');
	});
});
