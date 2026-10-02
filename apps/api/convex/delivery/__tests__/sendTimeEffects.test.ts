import { describe, expect, it } from 'vitest';
import {
	reduceClicked,
	reduceOpened,
	type EmailSendDoc,
	type SendRef,
	type TransactionalSendDoc,
} from '../sendLifecycle/reducers';
import { reduceDeliveryObservation } from '../sendLifecycle/deliveryObservation';
import { SEND_TIME_ATTRIBUTION_MS, sendTimeStatDelta } from '../sendLifecycle/sendTimeEffects';
import type { Id } from '../../_generated/dataModel';

// The send-time optimization hooks on the send lifecycle (ADR-0068): which
// engagements teach a contact's profile, and which counters an optimized send
// bumps for the report's comparison.

const SEND_ID = 'send1' as Id<'emailSends'>;
const CAMPAIGN_ID = 'campaign1' as Id<'campaigns'>;
const CONTACT_ID = 'contact1' as Id<'contacts'>;
const campaignRef: SendRef = { kind: 'campaign', id: SEND_ID };
const SENT_AT = 1_000_000;
const LATER = SENT_AT + 3_600_000;

function campaignSend(overrides: Partial<EmailSendDoc> = {}): EmailSendDoc {
	return {
		_id: SEND_ID,
		_creationTime: 0,
		campaignId: CAMPAIGN_ID,
		contactId: CONTACT_ID,
		contactEmail: 'jane@example.com',
		status: 'delivered',
		sentAt: SENT_AT,
		deliveredAt: SENT_AT + 1000,
		...overrides,
	} as unknown as EmailSendDoc;
}

const engagementEffects = (effects: ReadonlyArray<{ kind: string }>) =>
	effects.filter((e) => e.kind === 'send_time_engagement');

describe('send-time profile learning', () => {
	it('folds the first reader open our pixel judged to be a mail client', () => {
		const result = reduceOpened(
			campaignSend(),
			{ to: 'opened', at: LATER, agent: 'client' },
			campaignRef
		);
		expect(engagementEffects(result.effects)).toEqual([
			{ kind: 'send_time_engagement', contactId: CONTACT_ID, engagement: 'open', at: LATER },
		]);
	});

	it('never learns from Apple Mail Privacy Protection, scanners or arrival prefetches', () => {
		for (const agent of ['apple_proxy', 'scanner'] as const) {
			const result = reduceOpened(campaignSend(), { to: 'opened', at: LATER, agent }, campaignRef);
			expect(engagementEffects(result.effects)).toEqual([]);
		}
		const prefetch = reduceOpened(
			campaignSend(),
			{ to: 'opened', at: SENT_AT + 1000, agent: 'client' },
			campaignRef
		);
		expect(engagementEffects(prefetch.effects)).toEqual([]);
	});

	it('leaves out provider-reported opens, which say nothing about who fetched them', () => {
		const result = reduceOpened(campaignSend(), { to: 'opened', at: LATER }, campaignRef);
		expect(engagementEffects(result.effects)).toEqual([]);
	});

	it('learns once per send, from the first reader open only', () => {
		const result = reduceOpened(
			campaignSend({ openedAt: LATER - 60_000, status: 'opened' }),
			{ to: 'opened', at: LATER, agent: 'client' },
			campaignRef
		);
		expect(engagementEffects(result.effects)).toEqual([]);
	});

	it('folds the first reader click, not a scanner following the link', () => {
		const click = reduceClicked(
			campaignSend(),
			{ to: 'clicked', at: LATER, url: 'https://example.com', agent: 'client' },
			campaignRef
		);
		expect(engagementEffects(click.effects)).toEqual([
			{ kind: 'send_time_engagement', contactId: CONTACT_ID, engagement: 'click', at: LATER },
		]);
		const scanner = reduceClicked(
			campaignSend(),
			{ to: 'clicked', at: LATER, url: 'https://example.com', agent: 'scanner' },
			campaignRef
		);
		expect(engagementEffects(scanner.effects)).toEqual([]);
	});

	it('only learns from campaign mail', () => {
		const transactional = {
			_id: 'tx1',
			_creationTime: 0,
			kind: 'transactional',
			email: 'jane@example.com',
			contactId: CONTACT_ID,
			status: 'delivered',
			sentAt: SENT_AT,
		} as unknown as TransactionalSendDoc;
		const result = reduceOpened(
			transactional,
			{ to: 'opened', at: LATER, agent: 'client' },
			{ kind: 'transactional', id: 'tx1' as Id<'transactionalSends'> }
		);
		expect(engagementEffects(result.effects)).toEqual([]);
	});
});

describe('send-time comparison counters', () => {
	it('tags the campaign counters of an optimized send with its arm', () => {
		const send = campaignSend({ sendTimeGroup: 'holdout' });
		const opened = reduceOpened(send, { to: 'opened', at: LATER, agent: 'client' }, campaignRef);
		expect(opened.effects).toContainEqual({
			kind: 'campaign_stats_opened',
			campaignId: CAMPAIGN_ID,
			at: LATER,
			sendTimeGroup: 'holdout',
		});
		const clicked = reduceClicked(
			send,
			{ to: 'clicked', at: LATER, url: 'https://example.com', agent: 'client' },
			campaignRef
		);
		expect(clicked.effects).toContainEqual({
			kind: 'campaign_stats_clicked',
			campaignId: CAMPAIGN_ID,
			at: LATER,
			sendTimeGroup: 'holdout',
		});
		const delivered = reduceDeliveryObservation(
			campaignSend({ sendTimeGroup: 'optimized', deliveredAt: undefined, status: 'sent' }),
			LATER,
			campaignRef,
			'example.com',
			null
		);
		expect(delivered.effects).toContainEqual({
			kind: 'campaign_stats_delivered',
			campaignId: CAMPAIGN_ID,
			at: LATER,
			sendTimeGroup: 'optimized',
		});
	});

	it('credits an arm only with engagement inside the attribution window', () => {
		const send = campaignSend({ sendTimeGroup: 'holdout' });
		const late = SENT_AT + SEND_TIME_ATTRIBUTION_MS + 60_000;
		const opened = reduceOpened(send, { to: 'opened', at: late, agent: 'client' }, campaignRef);
		// The campaign still counts the open, and the profile still learns from it.
		expect(opened.effects).toContainEqual({
			kind: 'campaign_stats_opened',
			campaignId: CAMPAIGN_ID,
			at: late,
		});
		expect(engagementEffects(opened.effects)).toHaveLength(1);
		const clicked = reduceClicked(
			send,
			{ to: 'clicked', at: late, url: 'https://example.com', agent: 'client' },
			campaignRef
		);
		expect(clicked.effects).toContainEqual({
			kind: 'campaign_stats_clicked',
			campaignId: CAMPAIGN_ID,
			at: late,
		});
		const edge = SENT_AT + SEND_TIME_ATTRIBUTION_MS;
		const onTime = reduceOpened(send, { to: 'opened', at: edge, agent: 'client' }, campaignRef);
		expect(onTime.effects).toContainEqual({
			kind: 'campaign_stats_opened',
			campaignId: CAMPAIGN_ID,
			at: edge,
			sendTimeGroup: 'holdout',
		});
	});

	it('leaves a send outside an optimized campaign untagged', () => {
		const opened = reduceOpened(
			campaignSend(),
			{ to: 'opened', at: LATER, agent: 'client' },
			campaignRef
		);
		expect(opened.effects).toContainEqual({
			kind: 'campaign_stats_opened',
			campaignId: CAMPAIGN_ID,
			at: LATER,
		});
	});

	it('maps an arm and an event onto its counter', () => {
		expect(sendTimeStatDelta(undefined, 'opened')).toEqual({});
		expect(sendTimeStatDelta('optimized', 'delivered')).toEqual({
			statsSendTimeOptimizedDelivered: 1,
		});
		expect(sendTimeStatDelta('holdout', 'clicked')).toEqual({ statsSendTimeHoldoutClicked: 1 });
	});
});
