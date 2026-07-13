/**
 * Shared scaffolding for the E4 inbound-unseal test surfaces
 * (`e2ee/__tests__/open.test.ts`, `mail/__tests__/inboundUnseal.test.ts`,
 * `inbox/__tests__/inboundUnsealMirror.test.ts`). Extracted so the OpenPGP
 * keypair generator + the convex-test seed/read helpers + the protected-headers
 * inner-message builder live in ONE place instead of being copy-pasted across
 * all three (reviewer improvement — DRY the test scaffolding).
 */

import type { convexTest } from 'convex-test';
import * as openpgp from 'openpgp';
import type { DatabaseWriter } from '../../_generated/server';

/**
 * The full convex function module map for `convexTest(schema, modules)`. Every
 * e2ee suite needs it; extracted here ONCE (this file sits at the SAME directory
 * depth as the suites, so the relative `import.meta.glob` patterns are unchanged).
 */
const rootGlob = import.meta.glob('../../**/*.*s');
const e2eeGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../e2ee/'),
		mod,
	])
);
export const modules = { ...rootGlob, ...e2eeGlob };

/** The `convexTest(...)` handle type, shared so each suite need not re-derive it. */
export type ConvexTestCtx = ReturnType<typeof convexTest>;

export interface TestKeypair {
	fingerprint: string;
	publicKeyArmored: string;
	privateKeyArmored: string;
}

/** Generate a Curve25519 OpenPGP keypair for `email` (armored + fingerprint). */
export async function generateTestKeypair(email: string): Promise<TestKeypair> {
	const { privateKey, publicKey } = await openpgp.generateKey({
		type: 'curve25519',
		userIDs: [{ name: email, email }],
		format: 'armored',
	});
	const key = await openpgp.readKey({ armoredKey: publicKey });
	return {
		fingerprint: key.getFingerprint().toUpperCase(),
		publicKeyArmored: publicKey,
		privateKeyArmored: privateKey,
	};
}

/** Read a recipient's PUBLIC vault key (minted by `mintForAddress`) to seal TO it. */
export async function recipientVaultPublicKey(t: ConvexTestCtx, address: string): Promise<string> {
	return await t.run(async (ctx: { db: DatabaseWriter }) => {
		const row = await ctx.db
			.query('keyVault')
			.withIndex('by_address', (q) => q.eq('address', address))
			.first();
		if (!row) throw new Error('recipient vault key missing');
		return row.publicKeyArmored;
	});
}

/** Seed a TRUSTED pinned sender key so an inbound signature can verify against it. */
export async function seedPinnedSender(
	t: ConvexTestCtx,
	args: { address: string; domain: string; pinnedPublicKeyArmored: string }
): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('recipientKeys', {
			address: args.address,
			domain: args.domain,
			outcome: 'trusted',
			pinnedFingerprint: 'FP',
			pinnedPublicKeyArmored: args.pinnedPublicKeyArmored,
			expiresAt: now + 60_000,
			discoveredAt: now,
			updatedAt: now,
		});
	});
}

/** Build a protected-headers inner message (the plaintext that gets sealed). */
export function innerMessage(args: {
	from: string;
	to: string;
	subject: string;
	body: string;
	messageId: string;
}): string {
	return [
		`Message-ID: ${args.messageId}`,
		'Date: Mon, 13 Jul 2026 09:00:00 +0000',
		`From: ${args.from}`,
		`To: ${args.to}`,
		`Subject: ${args.subject}`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: 7bit',
		'',
		args.body,
		'',
	].join('\r\n');
}

/** The body bytes of an RFC822 message — everything after the first blank line. */
export function bodyOf(mime: string): string {
	const i = mime.indexOf('\r\n\r\n');
	return i >= 0 ? mime.slice(i + 4) : mime;
}
