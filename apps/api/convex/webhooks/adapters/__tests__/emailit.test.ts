import { describe, expect, it } from 'vitest';
import { emailitAdapter } from '../emailit';

const at = Date.parse('2026-08-09T08:00:00.000Z');

function payload(type: string, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		event_id: 'evt_1',
		type,
		data: {
			object: {
				id: 'em_123',
				to: 'person@example.com',
				updated_at: '2026-08-09T08:00:00.000Z',
				...overrides,
			},
		},
	});
}

describe('Emailit feedback semantics', () => {
	it.each([
		[
			'email.accepted',
			{ kind: 'email.sent', providerMessageId: 'em_123', at, providerType: 'emailit' },
		],
		[
			'email.delivered',
			{
				kind: 'email.delivered',
				providerMessageId: 'em_123',
				at,
				providerType: 'emailit',
				recipient: 'person@example.com',
			},
		],
		[
			'email.bounced',
			{
				kind: 'email.bounced',
				providerMessageId: 'em_123',
				at,
				providerType: 'emailit',
				bounceType: 'hard',
				bounceMessage: 'bounced',
			},
		],
		[
			'email.complained',
			{
				kind: 'email.complained',
				providerMessageId: 'em_123',
				at,
				providerType: 'emailit',
				recipient: 'person@example.com',
			},
		],
	] as const)('maps %s', (type, expected) => {
		expect(emailitAdapter.parseEvent(payload(type, { status: 'bounced' }))).toEqual(expected);
	});

	it('maps temporary attempts, failures, rejects, and suppressions without open vocabulary', () => {
		expect(
			emailitAdapter.parseEvent(payload('email.attempted', { status: 'temporary' }))
		).toMatchObject({
			kind: 'email.deferred',
			reason: 'temporary',
		});
		expect(emailitAdapter.parseEvent(payload('email.failed', { status: 'failed' }))).toMatchObject({
			kind: 'email.failed',
			errorCode: 'PROVIDER_FAILED',
		});
		expect(
			emailitAdapter.parseEvent(payload('email.rejected', { status: 'rejected' }))
		).toMatchObject({
			kind: 'email.failed',
			errorCode: 'PROVIDER_REJECTED',
		});
		expect(emailitAdapter.parseEvent(payload('email.suppressed'))).toMatchObject({
			kind: 'email.provider_suppressed',
			reason: 'recipient_blacklisted',
		});
	});

	it.each(['email.clicked', 'email.loaded', 'email.scheduled', 'email.received'])(
		'ignores %s so first-party tracking remains authoritative',
		(type) => expect(emailitAdapter.parseEvent(payload(type))).toBeNull()
	);

	it('fails closed on missing identity, recipient, or timestamp', () => {
		expect(() => emailitAdapter.parseEvent('{}')).toThrow(/Malformed/);
		expect(() =>
			emailitAdapter.parseEvent(payload('email.accepted', { updated_at: 'nope' }))
		).toThrow(/invalid timestamp/);
		expect(() => emailitAdapter.parseEvent(payload('email.suppressed', { to: undefined }))).toThrow(
			/no recipient/
		);
	});
});
