import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import { sendDoiConfirmation } from '../confirmationEmail';

afterEach(() => {
	vi.unstubAllEnvs();
});

function captureCtx(team: { name?: string; defaultFromEmail?: string } | null) {
	const runAction = vi.fn(async () => undefined);
	const runQuery = vi.fn(async () => team);
	return { ctx: { runAction, runQuery } as unknown as ActionCtx, runAction };
}

const args = {
	email: 'subscriber@example.com',
	confirmationToken: 'doi-token',
	siteUrl: 'https://app.example.com',
};

describe('the double opt-in mail sender', () => {
	it("prefers the team's own From address", async () => {
		vi.stubEnv('DEFAULT_FROM_DOMAIN', '');
		const { ctx, runAction } = captureCtx({ name: 'Acme', defaultFromEmail: 'news@acme.example' });
		await sendDoiConfirmation(ctx, args);
		expect(runAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ from: 'Acme <news@acme.example>' })
		);
	});

	it('falls back to the configured system sender', async () => {
		vi.stubEnv('DEFAULT_FROM_DOMAIN', 'mail.example.com');
		const { ctx, runAction } = captureCtx({ name: 'Acme' });
		await sendDoiConfirmation(ctx, args);
		expect(runAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ from: 'Acme <noreply@mail.example.com>' })
		);
	});

	it('fails with a configuration error, and sends nothing, when no sender is configured', async () => {
		vi.stubEnv('DEFAULT_FROM_DOMAIN', '');
		vi.stubEnv('DEFAULT_FROM_EMAIL', '');
		const { ctx, runAction } = captureCtx({ name: 'Acme' });
		await expect(sendDoiConfirmation(ctx, args)).rejects.toThrow(/DEFAULT_FROM_DOMAIN/);
		expect(runAction).not.toHaveBeenCalled();
	});
});
