import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import type { InboundEventOf } from './types';

/** Apply an allowlisted recipient-specific suppression reported by a provider. */
export async function applyProviderSuppression(
	ctx: ActionCtx,
	event: InboundEventOf<'email.provider_suppressed'>
): Promise<void> {
	const bounced = event.reason === 'invalid_recipient';
	await ctx.runMutation(internal.blockedEmails.addFromEvent, {
		email: event.recipient,
		reason: bounced ? 'bounced' : 'manual',
		...(bounced ? { bounceType: 'hard' as const } : {}),
		provenance: {
			provider: event.providerType,
			source: 'webhook' as const,
			evidence: `PROVIDER_SUPPRESSED_${event.reason.toUpperCase()}`,
		},
	});
}
