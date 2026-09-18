/**
 * Mutation-runtime scheduler for the MTA suppression mirror action.
 *
 * Kept separate from `suppressionMirror.ts` so the action has a real
 * cross-module caller that the entry-wiring guard can prove. Callers schedule
 * after their authoritative `blockedEmails` write commits; mirror failures are
 * therefore isolated from the originating mutation.
 */

import { internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import type { BlockReason, MirroredBlockReason } from './suppressionMirror';

export async function scheduleSuppressionMirror(
	ctx: MutationCtx,
	args: { email: string; reason: MirroredBlockReason; bounceType?: 'hard' | 'soft' }
): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.delivery.suppressionMirror.mirror, {
		email: args.email,
		...(args.bounceType === 'soft' ? { expiresAt: Date.now() + 7 * 86400 * 1000 } : {}),
		reason: args.reason,
		...(args.bounceType ? { bounceType: args.bounceType } : {}),
	});
}

export async function scheduleSuppressionUnmirror(
	ctx: MutationCtx,
	email: string,
	reason: BlockReason
): Promise<void> {
	// Marketing-only sunset suppressions never reached the MTA. Removing one
	// must not erase a hard-bounce/complaint mirror for the same address.
	if (reason === 'unengaged') return;
	await ctx.scheduler.runAfter(0, internal.delivery.suppressionMirror.unmirror, { email });
}
