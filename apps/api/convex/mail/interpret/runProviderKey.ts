/**
 * What an interpretation run tells the instance's record of a refused AI
 * provider key (`lib/providerAuthFailure.ts`): a refusal opens or re-stamps
 * it, a run the provider accepted closes it. A failed write changes nothing
 * about the run's own outcome, so it is dropped; the next run tries again.
 */

import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';

export async function noteProviderKey(
	ctx: Pick<ActionCtx, 'runMutation'>,
	outcome: 'refused' | 'accepted'
): Promise<void> {
	const note =
		outcome === 'refused'
			? internal.aiRouting.providerHealth.noteAuthFailure
			: internal.aiRouting.providerHealth.noteAuthAccepted;
	await ctx.runMutation(note, {}).catch(() => undefined);
}
