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
				// Unrecognized free text is soft — see the classification test below.
				bounceType: 'soft',
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

	// A hard bounce blocklists the address permanently, so Emailit's free-text
	// `status` goes through the shared soft-default classifier rather than being
	// assumed hard.
	it.each([
		['550 5.1.1 user unknown', 'hard'],
		['recipient rejected by the receiving server', 'hard'],
		['mailbox full, try again later', 'soft'],
		['452 4.2.2 over quota', 'soft'],
		['bounced', 'soft'],
	] as const)('classifies the bounce status %s as %s', (status, bounceType) => {
		expect(emailitAdapter.parseEvent(payload('email.bounced', { status }))).toEqual({
			kind: 'email.bounced',
			providerMessageId: 'em_123',
			at,
			providerType: 'emailit',
			bounceType,
			bounceMessage: status,
		});
	});

	it('classifies a bounce carrying no status as soft, with no bounce message', () => {
		expect(emailitAdapter.parseEvent(payload('email.bounced', { status: undefined }))).toEqual({
			kind: 'email.bounced',
			providerMessageId: 'em_123',
			at,
			providerType: 'emailit',
			bounceType: 'soft',
		});
	});

	// Only `invalid_recipient` becomes a hard `bounced` block downstream; the
	// other two land a reversible `manual` one, so unrecognized text stays on the
	// conservative fallback.
	it.each([
		['invalid recipient', 'invalid_recipient'],
		['mailbox does not exist', 'invalid_recipient'],
		['550 no such user here', 'invalid_recipient'],
		['recipient rejected', 'recipient_rejected'],
		['delivery refused by the destination', 'recipient_rejected'],
		['spam complaint', 'recipient_blacklisted'],
		['suppressed', 'recipient_blacklisted'],
		[undefined, 'recipient_blacklisted'],
	] as const)('maps the suppression status %s to %s', (status, reason) => {
		expect(emailitAdapter.parseEvent(payload('email.suppressed', { status }))).toEqual({
			kind: 'email.provider_suppressed',
			providerMessageId: 'em_123',
			at,
			providerType: 'emailit',
			recipient: 'person@example.com',
			reason,
		});
	});

	it.each(['email.clicked', 'email.loaded', 'email.scheduled', 'email.received', 'email.future'])(
		'ignores %s so first-party tracking remains authoritative',
		(type) => expect(emailitAdapter.parseEvent(payload(type))).toBeNull()
	);

	// Repeated 400s risk Emailit disabling the endpoint, so telemetry we discard
	// anyway must not fail the delivery over a timestamp we never read.
	it.each(['email.clicked', 'email.loaded', 'email.scheduled', 'email.received', 'email.future'])(
		'ignores %s even when its timestamp is unparseable',
		(type) =>
			expect(
				emailitAdapter.parseEvent(payload(type, { updated_at: 'nope', created_at: 'nope' }))
			).toBeNull()
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

	// The fail-closed throw is deliberate for every kind the pipeline dispatches:
	// an event we cannot place in time must not be silently applied.
	it.each([
		'email.accepted',
		'email.attempted',
		'email.bounced',
		'email.complained',
		'email.delivered',
		'email.failed',
		'email.rejected',
		'email.suppressed',
	])('still throws on an unparseable timestamp for the actionable kind %s', (type) => {
		expect(() =>
			emailitAdapter.parseEvent(payload(type, { updated_at: 'nope', created_at: 'nope' }))
		).toThrow(/invalid timestamp/);
	});
});
