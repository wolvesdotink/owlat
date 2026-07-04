/**
 * `contextRetrievalStep.execute` grounding-source provenance.
 *
 * Alongside the advisory coverage signal, the context step records the EXACT
 * prior emails + knowledge entries it assembled into the briefing — the same
 * contact-scoped set the draft is grounded in — so the review UI can render a
 * "Grounded in:" list. This asserts the returned + persisted `groundingSources`
 * name only the sources that were actually fed (no cross-contact leakage: the
 * step lists only what retrieval, which is contact-scoped upstream, returned).
 *
 * All Convex query/action/mutation seams are mocked — no live backend.
 */

import { describe, it, expect } from 'vitest';
import { getFunctionName } from 'convex/server';
import type { Id } from '../../../../_generated/dataModel';
import { contextRetrievalStep, type GroundingSource } from '../index';

const messageId = 'msg_test' as Id<'inboundMessages'>;
const contactId = 'contact_test' as Id<'contacts'>;
const threadId = 'thread_test' as Id<'conversationThreads'>;

const input = { inboundMessageId: messageId };

type Legs = {
	contactId?: Id<'contacts'>;
	threadId?: Id<'conversationThreads'>;
	threadMessages?: Array<{
		_id: string;
		from: string;
		receivedAt: number;
		subject: string;
		textBody?: string;
	}>;
	knowledge?: Array<{
		_id: string;
		entryType: string;
		confidence: number;
		title: string;
		content: string;
		_score?: number;
	}>;
};

function makeCtx(legs: Legs) {
	const recorded: { value: Record<string, unknown> | null } = { value: null };
	const message = {
		from: 'sender@example.com',
		to: 'me@hl.camp',
		subject: 'Can you confirm my order shipped?',
		textBody: 'Hi, I placed order 123 last week — has it shipped yet?',
		receivedAt: Date.now(),
		contactId: legs.contactId,
		threadId: legs.threadId,
	};

	const ctx = {
		runQuery: async (ref: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('getMessage')) return message;
			if (name.includes('getContact')) return null;
			if (name.includes('getRecentActivities')) return [];
			if (name.includes('getThreadMessages')) return legs.threadMessages ?? [];
			if (name.includes('getOpenCommitments')) return [];
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

describe('contextRetrievalStep.execute — grounding sources', () => {
	it('records the thread emails + knowledge entries that were fed into the briefing', async () => {
		const { ctx, recorded } = makeCtx({
			contactId,
			threadId,
			threadMessages: [
				{ _id: 'm_prev', from: 'sender@example.com', receivedAt: Date.now(), subject: 'Order 123', textBody: 'Earlier message' },
			],
			knowledge: [
				{ _id: 'k1', entryType: 'fact', confidence: 0.9, title: 'Shipping policy', content: 'Orders ship within 2 days.', _score: 0.42 },
				{ _id: 'k2', entryType: 'fact', confidence: 0.8, title: 'Order 123 status', content: 'Shipped 2026-07-01.', _score: 0.71 },
			],
		});

		const { output } = await contextRetrievalStep.execute(ctx, input);

		const expected: GroundingSource[] = [
			{ type: 'thread', id: 'm_prev', title: 'Order 123' },
			{ type: 'knowledge', id: 'k1', title: 'Shipping policy' },
			{ type: 'knowledge', id: 'k2', title: 'Order 123 status' },
		];
		expect(output.groundingSources).toEqual(expected);

		// Persisted onto the inbound message alongside the context tier.
		expect(recorded.value?.['groundingSources']).toEqual(expected);
	});

	it('records no sources when nothing was retrieved, and omits the field on persist', async () => {
		const { ctx, recorded } = makeCtx({ contactId, threadId, threadMessages: [], knowledge: [] });

		const { output } = await contextRetrievalStep.execute(ctx, input);

		expect(output.groundingSources).toEqual([]);
		// Omitted from the mutation args (patched only when non-empty), so an
		// ungrounded message carries no groundingSources field at all.
		expect('groundingSources' in (recorded.value ?? {})).toBe(false);
	});

	it('drops sources truncated out of the briefing so the list never over-claims', async () => {
		// A thread message whose body is huge enough to blow the token budget and
		// force compaction/emergency. Its content lands at the FRONT of the
		// briefing (conversation history precedes the current message), so the
		// tail-slice / contact+current-only reduction drops it entirely — and the
		// grounding list must drop with it rather than name an unseen source.
		const filler = 'x'.repeat(40_000);
		const { ctx, recorded } = makeCtx({
			contactId,
			threadId,
			threadMessages: [
				{ _id: 'm_prev', from: 'sender@example.com', receivedAt: Date.now(), subject: 'Truncated thread', textBody: filler },
			],
			knowledge: [
				{ _id: 'k1', entryType: 'fact', confidence: 0.9, title: 'Truncated knowledge', content: filler },
			],
		});

		const { output } = await contextRetrievalStep.execute(ctx, input);

		// Compaction/emergency kicked in and the front-loaded sources fell away.
		expect(output.tier).not.toBe('normal');
		expect(output.groundingSources).toEqual([]);
		// Nothing survived → field omitted from the persisted args.
		expect('groundingSources' in (recorded.value ?? {})).toBe(false);
	});
});
