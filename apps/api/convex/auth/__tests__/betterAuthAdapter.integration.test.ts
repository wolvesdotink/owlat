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

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

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

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(encoded: string): Uint8Array<ArrayBuffer> {
	const bytes: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (const char of encoded.replace(/=+$/, '')) {
		buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(char);
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((buffer >> bits) & 0xff);
		}
	}
	return new Uint8Array(bytes);
}

/**
 * Every code Better Auth's verifier accepts for the secret in `totpURI` at the
 * frozen `Date.now()`: RFC 6238 SHA-1, six digits, 30 s period, one step of
 * drift either way. A random secret makes any fixed "wrong" code valid one
 * time in 10^6, so the test picks its wrong codes outside this set.
 */
async function acceptedTotpCodes(totpURI: string): Promise<Set<string>> {
	const secret = base32Decode(new URL(totpURI).searchParams.get('secret')!);
	const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, [
		'sign',
	]);
	const step = Math.floor(Date.now() / 30_000);
	const codes = new Set<string>();
	for (let counter = step - 1; counter <= step + 1; counter++) {
		const message = new DataView(new ArrayBuffer(8));
		message.setBigUint64(0, BigInt(counter));
		const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message.buffer));
		const offset = mac[mac.length - 1]! & 0x0f;
		const binary = new DataView(mac.buffer).getUint32(offset) & 0x7fffffff;
		codes.add(String(binary % 1_000_000).padStart(6, '0'));
	}
	return codes;
}

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
		const enabled = await auth.api.enableTwoFactor({
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
		// Only Date is frozen, so the verifier's window is the one computed here.
		vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
		const accepted = await acceptedTotpCodes(enabled.totpURI!);
		const wrongCodes = ['000000', '111111', '222222', '333333', '444444']
			.filter((code) => !accepted.has(code))
			.slice(0, 2);
		expect(wrongCodes).toHaveLength(2);
		for (const code of wrongCodes) {
			await expect(
				auth.api.verifyTOTP({ headers: challengeHeaders, body: { code } })
			).rejects.toMatchObject({ status: 'UNAUTHORIZED' });
		}

		const [counted] = await rows(t, 'twoFactor');
		expect(counted).toMatchObject({ failedVerificationCount: 2 });

		// The derived set is the verifier's: one of its codes completes the sign-in.
		const signedIn = await auth.api.verifyTOTP({
			headers: challengeHeaders,
			body: { code: [...accepted][0]! },
		});
		expect(signedIn).toMatchObject({ user: { email: 'ada@owlat.example' } });
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
