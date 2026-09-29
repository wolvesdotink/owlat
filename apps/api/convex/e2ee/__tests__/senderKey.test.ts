/**
 * The shared sender-key TOFU ladder (`e2ee/senderKey.ts`) used by sealed-mail
 * open and inbound signature verification. `ctx.runQuery` / `ctx.runAction`
 * are mocked so each rung is asserted in isolation, including when discovery
 * must NOT run.
 */

import { describe, it, expect, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import type { ActionCtx } from '../../_generated/server';
import { resolveSenderVerificationKey } from '../senderKey';

const FROM = 'alice@sender.test';
const KEY = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nkey\n-----END PGP PUBLIC KEY BLOCK-----';
const HOUR = 60 * 60 * 1000;

type CachedRow = {
	outcome: 'trusted' | 'keyChanged' | 'notFound';
	pinnedPublicKeyArmored?: string;
	source?: 'wkd' | 'manifest';
	expiresAt: number;
} | null;

/**
 * Build a ctx whose `getCached` answers `before` until discovery has run and
 * `after` once it has. `discover` controls the discovery action itself.
 */
function mockCtx(opts: {
	before: CachedRow;
	after?: CachedRow;
	discover?: () => Promise<unknown>;
}) {
	let discovered = false;
	const runQuery = vi.fn(async (ref: unknown) => {
		expect(getFunctionName(ref as never)).toBe('e2ee/recipientKeys:getCached');
		return discovered ? (opts.after ?? null) : opts.before;
	});
	const runAction = vi.fn(async (ref: unknown) => {
		expect(getFunctionName(ref as never)).toBe('e2ee/discovery:discoverRecipientKey');
		discovered = true;
		return opts.discover ? await opts.discover() : { outcome: 'notFound' };
	});
	return { ctx: { runQuery, runAction } as unknown as ActionCtx, runQuery, runAction };
}

describe('resolveSenderVerificationKey', () => {
	it('uses a trusted pin directly, without discovery', async () => {
		const { ctx, runAction } = mockCtx({
			before: { outcome: 'trusted', pinnedPublicKeyArmored: KEY, expiresAt: Date.now() + HOUR },
		});
		await expect(resolveSenderVerificationKey(ctx, FROM, { skipManifest: true })).resolves.toEqual({
			status: 'found',
			publicKeyArmored: KEY,
			keySource: 'pinned',
		});
		expect(runAction).not.toHaveBeenCalled();
	});

	it('does not use a trusted pin whose key is empty (fresh row: notFound, no discovery)', async () => {
		const { ctx, runAction } = mockCtx({
			before: { outcome: 'trusted', pinnedPublicKeyArmored: '', expiresAt: Date.now() + HOUR },
		});
		await expect(resolveSenderVerificationKey(ctx, FROM, { skipManifest: false })).resolves.toEqual(
			{ status: 'notFound' }
		);
		expect(runAction).not.toHaveBeenCalled();
	});

	it('rediscovers past an expired trusted pin whose key is empty', async () => {
		const { ctx, runAction } = mockCtx({
			before: { outcome: 'trusted', pinnedPublicKeyArmored: '', expiresAt: Date.now() - 1 },
			after: {
				outcome: 'trusted',
				pinnedPublicKeyArmored: KEY,
				source: 'wkd',
				expiresAt: Date.now() + HOUR,
			},
		});
		await expect(resolveSenderVerificationKey(ctx, FROM, { skipManifest: false })).resolves.toEqual(
			{ status: 'found', publicKeyArmored: KEY, keySource: 'wkd' }
		);
		expect(runAction).toHaveBeenCalledTimes(1);
	});

	it('refuses a keyChanged pin without ever discovering past it', async () => {
		const { ctx, runAction } = mockCtx({
			// Even an expired conflict must not trigger discovery.
			before: { outcome: 'keyChanged', pinnedPublicKeyArmored: KEY, expiresAt: Date.now() - 1 },
		});
		await expect(resolveSenderVerificationKey(ctx, FROM, { skipManifest: true })).resolves.toEqual({
			status: 'keyChanged',
		});
		expect(runAction).not.toHaveBeenCalled();
	});

	it('answers a fresh negative from cache, without discovery', async () => {
		const { ctx, runAction } = mockCtx({
			before: { outcome: 'notFound', expiresAt: Date.now() + HOUR },
		});
		await expect(resolveSenderVerificationKey(ctx, FROM, { skipManifest: true })).resolves.toEqual({
			status: 'notFound',
		});
		expect(runAction).not.toHaveBeenCalled();
	});

	it('discovers once on first contact and reports the source of the new pin', async () => {
		const { ctx, runAction, runQuery } = mockCtx({
			before: null,
			after: {
				outcome: 'trusted',
				pinnedPublicKeyArmored: KEY,
				source: 'manifest',
				expiresAt: Date.now() + HOUR,
			},
		});
		await expect(resolveSenderVerificationKey(ctx, FROM, { skipManifest: false })).resolves.toEqual(
			{ status: 'found', publicKeyArmored: KEY, keySource: 'manifest' }
		);
		expect(runAction).toHaveBeenCalledTimes(1);
		expect(runQuery).toHaveBeenCalledTimes(2);
	});

	it("defaults a rediscovered pin with no recorded source to 'wkd'", async () => {
		const { ctx } = mockCtx({
			before: { outcome: 'notFound', expiresAt: Date.now() - 1 },
			after: { outcome: 'trusted', pinnedPublicKeyArmored: KEY, expiresAt: Date.now() + HOUR },
		});
		await expect(resolveSenderVerificationKey(ctx, FROM, { skipManifest: true })).resolves.toEqual({
			status: 'found',
			publicKeyArmored: KEY,
			keySource: 'wkd',
		});
	});

	it('resolves to notFound when discovery throws', async () => {
		const { ctx, runQuery } = mockCtx({
			before: null,
			discover: async () => {
				throw new Error('network down');
			},
		});
		await expect(resolveSenderVerificationKey(ctx, FROM, { skipManifest: true })).resolves.toEqual({
			status: 'notFound',
		});
		// No re-read after a failed discovery.
		expect(runQuery).toHaveBeenCalledTimes(1);
	});

	it('reports keyChanged when rediscovery surfaces a conflict', async () => {
		const { ctx } = mockCtx({
			before: { outcome: 'notFound', expiresAt: Date.now() - 1 },
			after: { outcome: 'keyChanged', pinnedPublicKeyArmored: KEY, expiresAt: Date.now() + HOUR },
		});
		await expect(resolveSenderVerificationKey(ctx, FROM, { skipManifest: true })).resolves.toEqual({
			status: 'keyChanged',
		});
	});

	it('resolves to notFound when rediscovery still finds nothing', async () => {
		const { ctx } = mockCtx({
			before: null,
			after: { outcome: 'notFound', expiresAt: Date.now() + HOUR },
		});
		await expect(resolveSenderVerificationKey(ctx, FROM, { skipManifest: true })).resolves.toEqual({
			status: 'notFound',
		});
	});

	it.each([true, false])(
		'forwards skipManifest=%s to discoverRecipientKey',
		async (skipManifest) => {
			const { ctx, runAction } = mockCtx({ before: null });
			await resolveSenderVerificationKey(ctx, FROM, { skipManifest });
			expect(runAction).toHaveBeenCalledWith(expect.anything(), { address: FROM, skipManifest });
		}
	);
});
