import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import { sendDoiConfirmation } from '../confirmationEmail';

afterEach(() => {
	vi.unstubAllEnvs();
});

/**
 * An action context whose first query answers the team's sender and whose
 * domain lookup answers `verified` for every address.
 */
function captureCtx(
	team: { name?: string; defaultFromEmail?: string } | null,
	options: { isDomainVerified?: boolean } = {}
) {
	const runAction = vi.fn(async () => undefined);
	const runQuery = vi.fn(async (_ref: unknown, queryArgs?: { email?: string }) =>
		queryArgs?.email === undefined
			? team
			: {
					domain: queryArgs.email.split('@')[1] ?? '',
					exists: true,
					verified: options.isDomainVerified ?? true,
					stale: false,
				}
	);
	return { ctx: { runAction, runQuery } as unknown as ActionCtx, runAction, runQuery };
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

	it('sends nothing from a sender whose domain is not verified, and the contact stays pending', async () => {
		vi.stubEnv('DEFAULT_FROM_DOMAIN', '');
		const { ctx, runAction, runQuery } = captureCtx(
			{ name: 'Acme', defaultFromEmail: 'news@acme.example' },
			{ isDomainVerified: false }
		);

		expect(await sendDoiConfirmation(ctx, args)).toEqual({ success: false });
		expect(runQuery).toHaveBeenCalledWith(expect.anything(), { email: 'news@acme.example' });
		expect(runAction).not.toHaveBeenCalled();
	});

	it('fails with a configuration error, and sends nothing, when no sender is configured', async () => {
		vi.stubEnv('DEFAULT_FROM_DOMAIN', '');
		vi.stubEnv('DEFAULT_FROM_EMAIL', '');
		const { ctx, runAction } = captureCtx({ name: 'Acme' });
		await expect(sendDoiConfirmation(ctx, args)).rejects.toThrow(/DEFAULT_FROM_DOMAIN/);
		expect(runAction).not.toHaveBeenCalled();
	});
});
