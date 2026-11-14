import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import { sendDeletionConfirmation } from '../accountDeletionEmail';

afterEach(() => {
	vi.unstubAllEnvs();
});

function captureCtx() {
	const runAction = vi.fn(async () => undefined);
	return { ctx: { runAction } as unknown as ActionCtx, runAction };
}

const args = {
	email: 'member@example.com',
	scheduledForDeletion: Date.UTC(2026, 5, 15),
	cancellationToken: 'cancel-token',
	siteUrl: 'https://app.example.com',
};

describe('the account deletion mail sender', () => {
	it('sends from the configured system sender', async () => {
		vi.stubEnv('DEFAULT_FROM_DOMAIN', 'mail.example.com');
		const { ctx, runAction } = captureCtx();
		await sendDeletionConfirmation(ctx, args);
		expect(runAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ from: 'Owlat <noreply@mail.example.com>' })
		);
	});

	it('fails with a configuration error, and sends nothing, when no sender is configured', async () => {
		vi.stubEnv('DEFAULT_FROM_DOMAIN', '');
		vi.stubEnv('DEFAULT_FROM_EMAIL', '');
		const { ctx, runAction } = captureCtx();
		await expect(sendDeletionConfirmation(ctx, args)).rejects.toThrow(/DEFAULT_FROM_DOMAIN/);
		expect(runAction).not.toHaveBeenCalled();
	});
});
