/**
 * Answer mode and read on arrival (Sol r2 F1): "Draft with AI" never drafts a
 * thread that is not fully read. The thread's gist-only or counted mail is
 * read in full first (`interpret/fullRead.ts`), waited for a little; when it
 * does not land in time the person is told to try again in a moment, and no
 * model was called.
 */

import type { ActionCtx } from '../../_generated/server';
import type { AnswerAskTarget } from '../../lib/validators/answerAsk';
import { throwRateLimited } from '../../_utils/errors';
import { awaitAskTargetFullRead } from '../interpret/fullReadPrepare';
import { FULL_READ_RECHECK_MS } from '../interpret/fullRead';

/** Wait until the target's thread is fully read, or refuse with a retry hint. */
export async function requireFullRead(
	ctx: Pick<ActionCtx, 'runMutation' | 'runQuery'>,
	target: AnswerAskTarget
): Promise<void> {
	if ((await awaitAskTargetFullRead(ctx, target)) === 'ready') return;
	throwRateLimited('This thread is still being read. Try again in a moment.', FULL_READ_RECHECK_MS);
}
