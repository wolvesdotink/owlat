import { afterEach, describe, expect, it, vi } from 'vitest';
import { newBetterAuthHarness } from '../../__tests__/testModules';
import { components } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import { createAuth } from '../auth';

/**
 * Drives Better Auth 1.7, configured exactly as production (`createAuth`),
 * through the Convex adapter into the local betterAuth component. The adapter
 * package only declares Better Auth 1.6 support, so
 * patches/@convex-dev%2Fbetter-auth@0.12.6.patch carries the 1.7 contract;
 * each case below fails without one part of it:
 *
 * - every read passes `modelKey`, which the component validators reject;
 * - one-time tokens are redeemed through `consumeOne`;
 * - two-factor lockout counts through `incrementOne`;
 * - `update` of a row that no longer exists must resolve to null;
 * - the JWT plugin stores `alg`/`crv` on new signing keys.
 *
 * Only the action plumbing is faked: `runQuery`/`runMutation` call the real
 * component functions in convex-test, and `runAction` (auth email) records the
 * message instead of sending it.
 */

afterEach(() => vi.unstubAllEnvs());

type SentEmail = { to: string; subject: string; html: string };

function harness() {
	vi.stubEnv('OWLAT_DEV_MODE', 'true');
	vi.stubEnv('SITE_URL', 'https://owlat.example');
	vi.stubEnv('CONVEX_SITE_URL', 'https://api.owlat.example');
	const t = newBetterAuthHarness();
	const sent: SentEmail[] = [];
	// The adapter forwards whichever component reference Better Auth asked for,
	// which no single instantiation of convex-test's generic signature describes.
	const forward = t as unknown as {
		query: (ref: unknown, args: unknown) => Promise<unknown>;
		mutation: (ref: unknown, args: unknown) => Promise<unknown>;
	};
	const ctx = {
		runQuery: (ref: unknown, args: unknown) => forward.query(ref, args),
		runMutation: (ref: unknown, args: unknown) => forward.mutation(ref, args),
		runAction: async (_ref: unknown, params: SentEmail) => {
			sent.push(params);
			return { success: true };
		},
	} as unknown as ActionCtx;
	return { t, auth: createAuth(ctx), sent };
}

function cookieHeaders(headers: Headers): Headers {
	const cookie = headers
		.getSetCookie()
		.map((value) => value.split(';')[0])
		.join('; ');
	return new Headers({ cookie });
}

async function rows(t: ReturnType<typeof harness>['t'], model: string) {
	const result = (await t.query(components.betterAuth.adapter.findMany, {
		model,
		where: [],
		paginationOpts: { cursor: null, numItems: 50 },
	} as never)) as { page: Array<Record<string, unknown>> };
	return result.page;
}

const PASSWORD = 'correct-horse-battery';

describe('Better Auth 1.7 over the Convex adapter', () => {
	it('signs up and signs in, reading through the component with modelKey stripped', async () => {
		const { t, auth } = harness();

		const signUp = await auth.api.signUpEmail({
			body: { email: 'ada@owlat.example', password: PASSWORD, name: 'Ada' },
		});
		expect(signUp.user.email).toBe('ada@owlat.example');

		const signIn = await auth.api.signInEmail({
			body: { email: 'ada@owlat.example', password: PASSWORD },
			returnHeaders: true,
		});
		const session = await auth.api.getSession({ headers: cookieHeaders(signIn.headers) });
		expect(session?.user.email).toBe('ada@owlat.example');

		// Sign-in mints the Convex JWT, which creates the signing key with the
		// algorithm the JWT plugin now records.
		const keys = await rows(t, 'jwks');
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatchObject({ alg: 'RS256' });
	});

	it('redeems a password-reset token once, through consumeOne', async () => {
		const { t, auth, sent } = harness();
		await auth.api.signUpEmail({
			body: { email: 'ada@owlat.example', password: PASSWORD, name: 'Ada' },
		});

		await auth.api.requestPasswordReset({ body: { email: 'ada@owlat.example' } });
		const resetMail = sent.find((mail) => mail.subject.startsWith('Reset your password'));
		const token = decodeURIComponent(/token=([^"&]+)/.exec(resetMail!.html)![1]!);
		expect(await rows(t, 'verification')).toHaveLength(1);

		await auth.api.resetPassword({ body: { token, newPassword: 'a-brand-new-password' } });
		expect(await rows(t, 'verification')).toHaveLength(0);
		await expect(
			auth.api.resetPassword({ body: { token, newPassword: 'a-second-new-password' } })
		).rejects.toMatchObject({ status: 'BAD_REQUEST' });

		const signIn = await auth.api.signInEmail({
			body: { email: 'ada@owlat.example', password: 'a-brand-new-password' },
		});
		expect(signIn.user.email).toBe('ada@owlat.example');
	});

	it('counts failed two-factor codes through incrementOne', async () => {
		const { t, auth } = harness();
		await auth.api.signUpEmail({
			body: { email: 'ada@owlat.example', password: PASSWORD, name: 'Ada' },
		});
		const first = await auth.api.signInEmail({
			body: { email: 'ada@owlat.example', password: PASSWORD },
			returnHeaders: true,
		});
		await auth.api.enableTwoFactor({
			headers: cookieHeaders(first.headers),
			body: { password: PASSWORD, method: 'totp' },
		});
		const [twoFactor] = await rows(t, 'twoFactor');
		const [user] = await rows(t, 'user');
		await t.mutation(components.betterAuth.adapter.updateOne, {
			input: {
				model: 'user',
				where: [{ field: '_id', value: user!['_id'] }],
				update: { twoFactorEnabled: true },
			},
		} as never);
		await t.mutation(components.betterAuth.adapter.updateOne, {
			input: {
				model: 'twoFactor',
				where: [{ field: '_id', value: twoFactor!['_id'] }],
				update: { verified: true },
			},
		} as never);

		const challenge = await auth.api.signInEmail({
			body: { email: 'ada@owlat.example', password: PASSWORD },
			returnHeaders: true,
		});
		expect(challenge.response).toMatchObject({ twoFactorRedirect: true });
		const challengeHeaders = cookieHeaders(challenge.headers);
		for (const code of ['000000', '111111']) {
			await expect(
				auth.api.verifyTOTP({ headers: challengeHeaders, body: { code } })
			).rejects.toMatchObject({ status: 'UNAUTHORIZED' });
		}

		const [counted] = await rows(t, 'twoFactor');
		expect(counted).toMatchObject({ failedVerificationCount: 2 });
	});

	it('resolves an update of a vanished row to null instead of throwing', async () => {
		const { auth } = harness();
		const { adapter } = await auth.$context;

		await expect(
			adapter.update({
				model: 'session',
				where: [{ field: 'token', value: 'revoked-meanwhile' }],
				update: { updatedAt: new Date() },
			})
		).resolves.toBeNull();
		await expect(
			adapter.incrementOne({
				model: 'twoFactor',
				where: [{ field: 'userId', value: 'nobody' }],
				increment: { failedVerificationCount: 1 },
			})
		).resolves.toBeNull();
		await expect(
			adapter.consumeOne({
				model: 'verification',
				where: [{ field: 'identifier', value: 'nothing-to-consume' }],
			})
		).resolves.toBeNull();
	});
});
