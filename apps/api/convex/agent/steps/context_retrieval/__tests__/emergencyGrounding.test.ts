/**
 * `contextRetrievalStep.execute` — emergency-tier grounding preservation.
 *
 * The emergency compaction tier fires on the longest / hardest threads, which
 * are precisely the ones that most need grounding. It used to collapse to
 * [CONTACT] + [CURRENT MESSAGE] only, throwing away every knowledge fact,
 * commitment, and file. These tests assert the new behaviour: on the emergency
 * tier the briefing PRESERVES the top knowledge facts + open commitments (not
 * contact-only) and gives [RECENT ACTIVITY] a one-line content snippet.
 *
 * Also covers the pure `activityContentSnippet` mapping. All Convex seams are
 * mocked — no live backend.
 */

import { describe, it, expect } from 'vitest';
import { getFunctionName } from 'convex/server';
import type { Id } from '../../../../_generated/dataModel';
import { contextRetrievalStep, activityContentSnippet } from '../index';

const messageId = 'msg_test' as Id<'inboundMessages'>;
const contactId = 'contact_test' as Id<'contacts'>;

const input = { inboundMessageId: messageId };

// A body large enough to push estimated tokens past maxTokens * 3 (≈48k chars)
// and force the emergency tier.
const HUGE_BODY = 'x'.repeat(60_000);

type Legs = {
	knowledge?: Array<{
		_id: string;
		entryType: string;
		confidence: number;
		title: string;
		content: string;
		_score?: number;
		isAuthoritative?: boolean;
	}>;
	commitments?: Array<{
		_id: string;
		entryType: string;
		title: string;
		content: string;
		dueAt?: number;
	}>;
	activities?: Array<{
		activityType: string;
		occurredAt: number;
		metadata?: Record<string, unknown>;
	}>;
};

function makeCtx(legs: Legs) {
	const recorded: { value: Record<string, unknown> | null } = { value: null };
	const message = {
		from: 'sender@example.com',
		to: 'me@hl.camp',
		subject: 'Long thread',
		textBody: HUGE_BODY,
		receivedAt: Date.now(),
		contactId,
		threadId: undefined,
	};

	const ctx = {
		runQuery: async (ref: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('getMessage')) return message;
			if (name.includes('getContact')) return { email: 'sender@example.com', firstName: 'Sam' };
			if (name.includes('getRecentActivities')) return legs.activities ?? [];
			if (name.includes('getThreadMessages')) return [];
			if (name.includes('getOpenCommitments')) return legs.commitments ?? [];
			if (name.includes('isGraphRetrievalEnabled')) return false;
			throw new Error(`unexpected runQuery: ${name}`);
		},
		runAction: async (ref: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('knowledge')) return legs.knowledge ?? [];
			if (name.includes('semanticFileProcessing')) return [];
			throw new Error(`unexpected runAction: ${name}`);
		},
		runMutation: async (ref: unknown, args: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('recordContextTier')) {
				recorded.value = args as Record<string, unknown>;
				return null;
			}
			throw new Error(`unexpected runMutation: ${name}`);
		},
	} as unknown as Parameters<typeof contextRetrievalStep.execute>[0];

	return { ctx, recorded };
}

describe('contextRetrievalStep.execute — emergency-tier grounding', () => {
	it('keeps the top knowledge facts on the emergency tier (not contact-only)', async () => {
		const { ctx, recorded } = makeCtx({
			knowledge: [
				{
					_id: 'k1',
					entryType: 'fact',
					confidence: 0.9,
					title: 'Refund policy',
					content: 'Refunds are issued within 14 days of purchase.',
				},
				{
					_id: 'k2',
					entryType: 'fact',
					confidence: 0.8,
					title: 'Warranty terms',
					content: 'Hardware carries a 2 year warranty.',
				},
			],
		});

		const { output } = await contextRetrievalStep.execute(ctx, input);

		expect(output.tier).toBe('emergency');
		// The top knowledge facts are preserved (compact), not dropped.
		expect(output.context).toContain('[KEY FACTS]');
		expect(output.context).toContain('Refund policy');
		expect(output.context).toContain('Refunds are issued within 14 days');
		// Still contact-grounded, and still carries the current message.
		expect(output.context).toContain('[CONTACT]');
		expect(output.context).toContain('[CURRENT MESSAGE]');
		// Grounding provenance reflects the preserved fact.
		expect(output.groundingSources).toContainEqual({
			type: 'knowledge',
			id: 'k1',
			title: 'Refund policy',
		});
		expect(recorded.value?.['contextTier']).toBe('emergency');
	});

	it('preserves open commitments and a recent-activity content snippet', async () => {
		const { ctx } = makeCtx({
			commitments: [
				{
					_id: 'c1',
					entryType: 'action_item',
					title: 'Ship feature X',
					content: 'We promised to ship feature X by Friday.',
				},
			],
			activities: [
				{
					activityType: 'email_sent',
					occurredAt: Date.now(),
					metadata: { emailSubject: 'Your quote is ready' },
				},
			],
		});

		const { output } = await contextRetrievalStep.execute(ctx, input);

		expect(output.tier).toBe('emergency');
		expect(output.context).toContain('OPEN COMMITMENTS');
		expect(output.context).toContain('Ship feature X');
		// [RECENT ACTIVITY] now carries a content snippet, not just a timestamp.
		expect(output.context).toContain('[RECENT ACTIVITY]');
		expect(output.context).toContain('Your quote is ready');
	});
});

describe('activityContentSnippet', () => {
	it('derives a one-line snippet from typed activity metadata', () => {
		expect(activityContentSnippet({ metadata: { emailSubject: 'Hello' } })).toBe('"Hello"');
		expect(activityContentSnippet({ metadata: { linkUrl: 'https://x.test/a' } })).toBe(
			'https://x.test/a'
		);
		expect(activityContentSnippet({ metadata: { topicName: 'Newsletter' } })).toBe('Newsletter');
		expect(activityContentSnippet({ metadata: { propertyKey: 'plan', newValue: 'pro' } })).toBe(
			'plan → pro'
		);
	});

	it('returns empty string when there is nothing human-meaningful', () => {
		expect(activityContentSnippet({ metadata: null })).toBe('');
		expect(activityContentSnippet({})).toBe('');
		// Metadata present but none of the human-meaningful fields set.
		expect(activityContentSnippet({ metadata: {} })).toBe('');
	});

	it('length-caps a long snippet', () => {
		const long = 'y'.repeat(500);
		const out = activityContentSnippet({ metadata: { topicName: long } });
		expect(out.length).toBeLessThanOrEqual(121);
		expect(out.endsWith('…')).toBe(true);
	});
});
