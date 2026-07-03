/**
 * `contextRetrievalStep.execute` retrieval-coverage signal.
 *
 * The context step emits a CHEAP, ADVISORY coverage summary — which briefing
 * legs were populated, knowledge-hit count, top retrieval score, and a derived
 * `lowCoverage` boolean — and persists it on the inbound message alongside
 * `contextTier`. No extra LLM call: coverage is derived from what retrieval
 * already computed. All Convex query/action/mutation seams are mocked so we can
 * assert the returned + persisted coverage without a live backend.
 */

import { describe, it, expect } from 'vitest';
import { getFunctionName } from 'convex/server';
import type { Id } from '../../../../_generated/dataModel';
import { contextRetrievalStep } from '../index';

const messageId = 'msg_test' as Id<'inboundMessages'>;
const contactId = 'contact_test' as Id<'contacts'>;
const threadId = 'thread_test' as Id<'conversationThreads'>;

const input = { inboundMessageId: messageId };

type Legs = {
	contactId?: Id<'contacts'>;
	threadId?: Id<'conversationThreads'>;
	contact?: { email: string } | null;
	activities?: Array<{ activityType: string; occurredAt: number }>;
	threadMessages?: Array<{
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
	files?: Array<{ filename: string; title?: string; summary?: string }>;
};

/** Captures the args handed to recordContextTier for persistence assertions. */
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
			const name = getFunctionName(
				ref as Parameters<typeof getFunctionName>[0],
			);
			if (name.includes('getMessage')) return message;
			if (name.includes('getContact')) return legs.contact ?? null;
			if (name.includes('getRecentActivities')) return legs.activities ?? [];
			if (name.includes('getThreadMessages')) return legs.threadMessages ?? [];
			if (name.includes('isGraphRetrievalEnabled')) return false;
			throw new Error(`unexpected runQuery: ${name}`);
		},
		runAction: async (ref: unknown) => {
			const name = getFunctionName(
				ref as Parameters<typeof getFunctionName>[0],
			);
			// knowledge/retrieval.semanticSearch
			if (name.includes('knowledge')) return legs.knowledge ?? [];
			// semanticFileProcessing.semanticSearch
			if (name.includes('semanticFileProcessing')) return legs.files ?? [];
			throw new Error(`unexpected runAction: ${name}`);
		},
		runMutation: async (ref: unknown, args: unknown) => {
			const name = getFunctionName(
				ref as Parameters<typeof getFunctionName>[0],
			);
			if (name.includes('recordContextTier')) {
				recorded.value = args as Record<string, unknown>;
				return null;
			}
			throw new Error(`unexpected runMutation: ${name}`);
		},
	} as unknown as Parameters<typeof contextRetrievalStep.execute>[0];

	return { ctx, recorded };
}

describe('contextRetrievalStep.execute — coverage signal', () => {
	it('reflects populated legs and is NOT low-coverage when knowledge hits exist', async () => {
		const { ctx, recorded } = makeCtx({
			contactId,
			threadId,
			contact: { email: 'sender@example.com' },
			threadMessages: [
				{
					from: 'sender@example.com',
					receivedAt: Date.now(),
					subject: 'Order 123',
					textBody: 'Earlier message',
				},
			],
			knowledge: [
				{
					_id: 'k1',
					entryType: 'fact',
					confidence: 0.9,
					title: 'Shipping policy',
					content: 'Orders ship within 2 days.',
					_score: 0.42,
				},
				{
					_id: 'k2',
					entryType: 'fact',
					confidence: 0.8,
					title: 'Order 123 status',
					content: 'Shipped 2026-07-01.',
					_score: 0.71,
				},
			],
			files: [{ filename: 'invoice.pdf', title: 'Invoice 123' }],
		});

		const { output } = await contextRetrievalStep.execute(ctx, input);

		expect(output.coverage).toEqual({
			contact: true,
			thread: true,
			knowledge: true,
			files: true,
			knowledgeHitCount: 2,
			topScore: 0.71,
			lowCoverage: false,
		});

		// Persisted alongside contextTier on the inbound message.
		expect(recorded.value).not.toBeNull();
		expect(recorded.value?.inboundMessageId).toBe(messageId);
		expect(recorded.value?.contextTier).toBe('normal');
		expect(recorded.value?.contextCoverage).toEqual(output.coverage);
	});

	it('is low-coverage when every grounding leg is empty', async () => {
		const { ctx, recorded } = makeCtx({
			// No contactId → no contact/activities; no threadId → no thread.
			knowledge: [],
			files: [],
		});

		const { output } = await contextRetrievalStep.execute(ctx, input);

		expect(output.coverage).toEqual({
			contact: false,
			thread: false,
			knowledge: false,
			files: false,
			knowledgeHitCount: 0,
			lowCoverage: true,
		});
		expect(output.coverage.topScore).toBeUndefined();
		expect(recorded.value?.contextCoverage).toEqual(output.coverage);
	});

	it('stays grounded (not low-coverage) on thread history alone, no knowledge/files', async () => {
		const { ctx } = makeCtx({
			threadId,
			threadMessages: [
				{
					from: 'sender@example.com',
					receivedAt: Date.now(),
					subject: 'Order 123',
					textBody: 'Prior context',
				},
			],
			knowledge: [],
			files: [],
		});

		const { output } = await contextRetrievalStep.execute(ctx, input);

		expect(output.coverage.thread).toBe(true);
		expect(output.coverage.knowledge).toBe(false);
		expect(output.coverage.lowCoverage).toBe(false);
	});
});
