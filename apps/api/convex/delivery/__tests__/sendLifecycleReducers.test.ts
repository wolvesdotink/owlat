import { describe, it, expect } from 'vitest';
import {
	legalEdgesFor,
	reduceSent,
	reduceFailed,
	reduceBounced,
	type EmailSendDoc,
	type SendRef,
} from '../sendLifecycle/reducers';
import type { Doc, Id } from '../../_generated/dataModel';

// Pure unit tests for the send-lifecycle reducers. These import the reducers
// DIRECTLY (no convex-test harness, no ctx/IO runner) — which is exactly what
// the reducers/effects/lookups split enables: the reducers are pure functions
// of (loaded Send, transition args) → { patch, effects, applied }. The DB-side
// behaviour is covered by the integration suites (sendLifecycle.integration,
// sendLifecycleEffects.integration); these lock in the pure-reducer contract.

const SEND_ID = 'send1' as Id<'emailSends'>;
const CAMPAIGN_ID = 'campaign1' as Id<'campaigns'>;
const CONTACT_ID = 'contact1' as Id<'contacts'>;

const campaignRef: SendRef = { kind: 'campaign', id: SEND_ID };

// Minimal emailSends row — only the fields the reducers read. Cast through the
// Doc type; the reducers never touch the convex `_creationTime`/system fields.
function campaignSend(overrides: Partial<EmailSendDoc> = {}): EmailSendDoc {
	return {
		_id: SEND_ID,
		_creationTime: 0,
		campaignId: CAMPAIGN_ID,
		contactId: CONTACT_ID,
		contactEmail: 'jane@example.com',
		status: 'queued',
		...overrides,
	} as unknown as EmailSendDoc;
}

describe('legalEdgesFor', () => {
	it('queued may only advance to sent/failed', () => {
		const edges = legalEdgesFor(campaignSend({ status: 'queued' }));
		expect([...edges].sort()).toEqual(['failed', 'sent']);
	});

	it('a HARD-bounced row is terminal (no legal outgoing edges)', () => {
		const edges = legalEdgesFor(campaignSend({ status: 'bounced', bounceType: 'hard' }));
		expect(edges.size).toBe(0);
	});

	it('a SOFT-bounced row is NON-terminal — it may harden or draw a complaint', () => {
		const edges = legalEdgesFor(campaignSend({ status: 'bounced', bounceType: 'soft' }));
		expect([...edges].sort()).toEqual(['bounced', 'complained']);
	});
});

describe('reduceSent', () => {
	it('queued → sent: patches status + provider id and emits the send effects', () => {
		const result = reduceSent(
			campaignSend({ status: 'queued' }),
			{ to: 'sent', at: 1000, providerMessageId: 'pm-1' },
			campaignRef,
			'org.example'
		);
		expect(result.applied).toBe('transitioned');
		expect(result.from).toBe('queued');
		expect(result.to).toBe('sent');
		expect(result.patch).toMatchObject({
			status: 'sent',
			sentAt: 1000,
			providerMessageId: 'pm-1',
		});
		const kinds = result.effects.map((e) => e.kind);
		expect(kinds).toContain('campaign_stats_sent');
		expect(kinds).toContain('daily_stats_bump');
		expect(kinds).toContain('reputation_update');
		expect(kinds).toContain('customer_webhook');
	});

	it('re-firing sent on an already-sent row is a duplicate no-op (no effects)', () => {
		const result = reduceSent(
			campaignSend({ status: 'sent' }),
			{ to: 'sent', at: 2000, providerMessageId: 'pm-2' },
			campaignRef,
			'org.example'
		);
		expect(result.applied).toBe('duplicate');
		expect(result.patch).toEqual({});
		expect(result.effects).toEqual([]);
	});

	it('counts MTA SMTP acceptance as delivered volume without changing Send status', () => {
		const result = reduceSent(
			campaignSend({ status: 'queued' }),
			{ to: 'sent', at: 1000, providerMessageId: 'pm-mta', providerType: 'mta' },
			campaignRef,
			'org.example'
		);
		const reputationEvents = result.effects.filter((effect) => effect.kind === 'reputation_update');
		expect(reputationEvents).toEqual([
			{ kind: 'reputation_update', eventType: 'send', domain: 'org.example' },
			{ kind: 'reputation_update', eventType: 'deliver', domain: 'org.example' },
		]);
		expect(result.patch['status']).toBe('sent');
	});
});

describe('reduceFailed', () => {
	it('records the error and emits the campaign_stats_failed effect', () => {
		const result = reduceFailed(
			campaignSend({ status: 'queued' }),
			{ to: 'failed', at: 3000, errorMessage: 'nope', errorCode: '5.1.1' },
			campaignRef
		);
		expect(result.applied).toBe('transitioned');
		expect(result.patch).toMatchObject({
			status: 'failed',
			errorMessage: 'nope',
			errorCode: '5.1.1',
		});
		expect(result.effects.map((e) => e.kind)).toContain('campaign_stats_failed');
	});

	// The MTA ambiguous-drop `failed` webhook event relies on this: a terminal
	// `failed` transition must NEVER suppress the recipient (no blocklist insert) —
	// the receiver may have accepted the message and the address is likely valid.
	it('never suppresses the recipient (no blocklist_insert effect)', () => {
		const result = reduceFailed(
			campaignSend({ status: 'queued' }),
			{
				to: 'failed',
				at: 3000,
				errorMessage: 'ambiguous post-DATA drop',
				errorCode: 'ambiguous_post_data',
			},
			campaignRef
		);
		expect(result.effects.some((e) => e.kind === 'blocklist_insert')).toBe(false);
	});
});

describe('reduceBounced', () => {
	const recipient = {
		_id: CONTACT_ID,
		_creationTime: 0,
		email: 'jane@example.com',
		softBounceCount: 4,
	} as unknown as Doc<'contacts'>;

	it('a hard bounce blocklists the address and is terminal', () => {
		const result = reduceBounced(
			campaignSend({ status: 'sent' }),
			{ to: 'bounced', at: 4000, bounceType: 'hard' },
			campaignRef,
			'jane@example.com',
			'org.example',
			null
		);
		expect(result.applied).toBe('transitioned');
		expect(result.patch).toMatchObject({ status: 'bounced', bounceType: 'hard' });
		const block = result.effects.find((e) => e.kind === 'blocklist_insert');
		expect(block).toMatchObject({ reason: 'bounced', bounceType: 'hard' });
	});

	it('the Nth soft bounce that reaches the threshold escalates to the blocklist', () => {
		// softBounceCount 4 → 5 hits SOFT_BOUNCE_SUPPRESSION_THRESHOLD.
		const result = reduceBounced(
			campaignSend({ status: 'sent' }),
			{ to: 'bounced', at: 5000, bounceType: 'soft' },
			campaignRef,
			'jane@example.com',
			'org.example',
			recipient
		);
		const counter = result.effects.find((e) => e.kind === 'contact_soft_bounce_count');
		expect(counter).toMatchObject({ count: 5 });
		const block = result.effects.find((e) => e.kind === 'blocklist_insert');
		expect(block).toMatchObject({ reason: 'bounced', bounceType: 'soft' });
	});

	it('a duplicate hard bounce on an already-hard-bounced row is a no-op', () => {
		const result = reduceBounced(
			campaignSend({ status: 'bounced', bounceType: 'hard' }),
			{ to: 'bounced', at: 6000, bounceType: 'hard' },
			campaignRef,
			'jane@example.com',
			'org.example',
			null
		);
		expect(result.applied).toBe('duplicate');
		expect(result.effects).toEqual([]);
	});
});
