/**
 * Label membership rows for tests that seed `mailMessages` directly: a raw
 * insert bypasses the writers that keep `mailLabelMessages`, so a fixture
 * reaches the indexed label reads only by running the mailbox's backfill, the
 * same walk migration 0074 runs.
 */

import type { TestConvex } from 'convex-test';
import type schema from '../schema';
import type { Doc, Id } from '../_generated/dataModel';
import { backfillLabelMembershipStep } from '../mail/labelMessageIndex';

/** Pages per backfill before the helper gives up on a walk that never finishes. */
const MAX_PAGES = 1000;

/** Walk the mailbox's backfill to its end, so readers use its label rows. */
export async function readyLabelRows(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>
): Promise<void> {
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const step = await t.run((ctx) => backfillLabelMembershipStep(ctx, mailboxId, 500));
		if (step.isReady) return;
	}
	throw new Error('label membership backfill did not finish');
}

/** Every label row of one message. */
export async function labelRowsOf(
	t: TestConvex<typeof schema>,
	messageId: Id<'mailMessages'>
): Promise<Doc<'mailLabelMessages'>[]> {
	return await t.run((ctx) =>
		ctx.db
			.query('mailLabelMessages')
			.withIndex('by_message_and_label', (q) => q.eq('messageId', messageId))
			.collect()
	);
}
