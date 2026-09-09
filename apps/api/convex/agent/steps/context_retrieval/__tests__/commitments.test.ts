/**
 * `contextRetrievalStep.execute` open-commitments recall.
 *
 * A promise we owe a contact must land in the briefing INDEPENDENT of whether the
 * new inbound restates it — semantic retrieval alone surfaces it only when the
 * email mentions it, exactly when it is least needed. This asserts the step pulls
 * open commitments for the contact (a separate contact-scoped query) and renders
 * them as a first-class [OPEN COMMITMENTS] section even when the semantic
 * knowledge/thread/file legs return nothing relevant to the inbound.
 *
 * All Convex query/action/mutation seams are mocked — no live backend.
 */

import { describe, it, expect } from 'vitest';
import { makeStepCtx } from '../../__tests__/stepCtx';
import type { Id } from '../../../../_generated/dataModel';
import { contextRetrievalStep } from '../index';

const messageId = 'msg_test' as Id<'inboundMessages'>;
const contactId = 'contact_test' as Id<'contacts'>;

const input = { inboundMessageId: messageId };

type OpenCommitment = {
	_id: string;
	entryType: string;
	title: string;
	content: string;
	dueAt?: number;
};

function makeCtx(openCommitments: OpenCommitment[]) {
	const recorded: { value: Record<string, unknown> | null } = { value: null };
	// The inbound is about something ELSE entirely — it never mentions the
	// commitment, so only the contact-scoped pull can surface it.
	const message = {
		from: 'sender@example.com',
		to: 'me@hl.camp',
		subject: 'Quick question about your newsletter',
		textBody: 'Hi — how do I change which topics I get emails about?',
		receivedAt: Date.now(),
		contactId,
		threadId: undefined,
	};

	const ctx = makeStepCtx<Parameters<typeof contextRetrievalStep.execute>[0]>({
		queries: {
			getMessage: message,
			getContact: { email: 'sender@example.com' },
			getRecentActivities: [],
			getOpenCommitments: openCommitments,
			getThreadMessages: [],
			isGraphRetrievalEnabled: false,
		},
		// Semantic knowledge + file legs find nothing tied to this inbound.
		actions: { knowledge: [], semanticFileProcessing: [] },
		mutations: {
			recordContextTier: (args) => {
				recorded.value = args as Record<string, unknown>;
				return null;
			},
		},
	});

	return { ctx, recorded };
}

describe('contextRetrievalStep.execute — open commitments', () => {
	it('injects an open commitment for the contact even when the new email never mentions it', async () => {
		const dueAt = Date.UTC(2026, 6, 10);
		const { ctx, recorded } = makeCtx([
			{
				_id: 'commit_1',
				entryType: 'action_item',
				title: 'Send revised quote',
				content: 'We promised to send the revised quote by Friday.',
				dueAt,
			},
		]);

		const { output } = await contextRetrievalStep.execute(ctx, input);

		// The commitment is in the briefing despite the inbound being about topics.
		expect(output.context).toContain('[OPEN COMMITMENTS');
		expect(output.context).toContain('Send revised quote');
		expect(output.context).toContain('We promised to send the revised quote by Friday.');
		expect(output.context).toContain(new Date(dueAt).toISOString());

		// It counts as grounding (so lowCoverage is not falsely set) and is named
		// as a grounding source for the review UI.
		expect(output.coverage.knowledge).toBe(true);
		expect(output.coverage.lowCoverage).toBe(false);
		expect(output.groundingSources).toContainEqual({
			type: 'knowledge',
			id: 'commit_1',
			title: 'Send revised quote',
		});
		expect(
			(recorded.value?.['groundingSources'] as Array<{ id: string }> | undefined)?.some(
				(s) => s.id === 'commit_1'
			)
		).toBe(true);
	});

	it('adds no [OPEN COMMITMENTS] section when the contact has none', async () => {
		const { ctx } = makeCtx([]);
		const { output } = await contextRetrievalStep.execute(ctx, input);
		expect(output.context).not.toContain('[OPEN COMMITMENTS');
		// With no thread/knowledge/files/commitments, coverage is low.
		expect(output.coverage.lowCoverage).toBe(true);
	});
});
