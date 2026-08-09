import { describe, expect, it, vi } from 'vitest';
import { applyProviderSuppression } from '../providerSuppression';

describe('portable provider suppression effects', () => {
	it.each([
		['invalid_recipient', 'bounced', 'hard'],
		['recipient_rejected', 'manual', undefined],
		['recipient_blacklisted', 'manual', undefined],
	] as const)('maps %s to the bounded host reason', async (wireReason, reason, bounceType) => {
		const runMutation = vi.fn().mockResolvedValue(null);
		await applyProviderSuppression({ runMutation } as never, {
			kind: 'email.provider_suppressed',
			recipient: 'blocked@example.com',
			at: Date.now(),
			reason: wireReason,
			providerType: 'plugin.acme.mail',
		});
		expect(runMutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				email: 'blocked@example.com',
				reason,
				...(bounceType ? { bounceType } : {}),
				provenance: {
					provider: 'plugin.acme.mail',
					source: 'webhook',
					evidence: `PROVIDER_SUPPRESSED_${wireReason.toUpperCase()}`,
				},
			})
		);
	});
});
