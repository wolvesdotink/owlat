/**
 * The team briefing's read (review round 2, F9): the items of the message
 * being answered are loaded on their own, through the source's lineage
 * record, so a thread with more open items than one read still shows every
 * current-message obligation, and the overflow holds auto-send (D3).
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { sealBodyAtWrite } from '../../../lib/messageBody';
import { BRIEFING_ITEM_READ } from '../teamActions';
import { modules, seedTeamThread, type Test } from './interpret.testlib';

const AT = Date.UTC(2026, 9, 7, 9, 0);

async function insertItem(
	t: Test,
	threadId: Id<'conversationThreads'>,
	text: string,
	askedAt: number,
	source: { kind: 'inbound'; id: Id<'inboundMessages'> }
) {
	const sealed = await sealBodyAtWrite(text);
	return t.run(async (ctx) =>
		ctx.db.insert('threadItems', {
			threadKind: 'team',
			conversationThreadId: threadId,
			revision: 1,
			intent: 'request',
			facets: [],
			assertion: sealed,
			display: { en: sealed, de: sealed },
			requester: { email: 'customer@example.com', isUs: false },
			responsible: { isUs: true },
			responsibility: 'us',
			status: 'open',
			disposition: 'unanswered',
			evidence: [{ source, segmentId: 's0', start: 0, end: 4, contentRevision: 'rev-1' }],
			verify: 'passed',
			askedAt,
			createdAt: askedAt,
			updatedAt: askedAt,
		})
	);
}

describe('team briefing read', () => {
	it('shows every item of the current message even behind a full page of older ones, and holds', async () => {
		const t = convexTest(schema, modules);
		const { threadId, inboundId } = await seedTeamThread(t);
		const olderId = await t.run(async (ctx) =>
			ctx.db.insert('inboundMessages', {
				messageId: '<older@example.com>',
				from: 'customer@example.com',
				to: 'support@owlat.test',
				subject: 'Order 42',
				textBody: 'Earlier',
				processingStatus: 'sent',
				receivedAt: AT - 10_000,
				threadId,
			})
		);
		for (let i = 0; i < BRIEFING_ITEM_READ + 5; i++) {
			await insertItem(t, threadId, `older ask ${i}`, AT - 10_000 + i, {
				kind: 'inbound',
				id: olderId,
			});
		}
		// The current message's item is the newest: it sorts behind every older one.
		const currentItem = await insertItem(t, threadId, 'Refund order 42 by Monday', AT, {
			kind: 'inbound',
			id: inboundId,
		});
		await t.run(async (ctx) =>
			ctx.db.insert('interpretSources', {
				threadKind: 'team',
				conversationThreadId: threadId,
				source: { kind: 'inbound', id: inboundId },
				sourceKey: `inbound:${inboundId}`,
				eligibility: {
					isLive: true,
					isThreadMuted: false,
					isBulkHeaderPresent: false,
					isSenderKnown: true,
				},
				claimIds: [{ key: 'k1', itemId: currentItem }],
				createdAt: AT,
				updatedAt: AT,
			})
		);

		const read = await t.query(internal.mail.interpret.teamActions.briefingActions, {
			inboundMessageId: inboundId,
		});
		expect(read.selection.ours.filter((i) => i.isFromCurrentMessage).map((i) => i.text)).toEqual([
			'Refund order 42 by Monday',
		]);
		expect(read.selection.isReadTruncated).toBe(true);
		expect(read.selection.omitted).toBeGreaterThan(0);

		const hold = await t.query(internal.mail.interpret.teamActions.interpretationHold, {
			inboundMessageId: inboundId,
		});
		expect(hold.reason).not.toBeNull();
	});
});
