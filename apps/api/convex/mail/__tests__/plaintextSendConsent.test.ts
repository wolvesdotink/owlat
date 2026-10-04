/**
 * Plaintext consent at dispatch (Sealed Mail on). Ordinary mail to a recipient
 * without a sealing key goes out as normal email; only a send that could have
 * been sealed (the sender's signing key is missing) returns to the composer for
 * an explicit choice. Regression: with the flag on, every Send to a keyless
 * recipient needed a confirm, and a dispatch without it bounced the draft back
 * to `draft` with nothing on screen.
 */

import { readFileSync } from 'node:fs';
import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as openpgp from 'openpgp';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { modules } from '../../__tests__/testModulesWithoutNodeActions';

// Only the resolver is replaced, with a public-unicast answer, so the discovery
// fetch guard runs for real against an allowed address.
vi.mock('node:dns/promises', () => {
	const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
	return { default: { lookup }, lookup };
});

type T = ReturnType<typeof convexTest>;

/**
 * Seed a pending send from alice (no signing key) to `to`. `recipient` seeds
 * the key cache; without it the cache is cold and dispatch looks the key up.
 */
async function seedDraft(
	t: T,
	recipient: { outcome: 'trusted' | 'notFound'; key?: string } | null,
	to = 'bob@b.test'
) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('instanceSettings', {
			featureFlags: { postbox: true, senderAuthBadges: true, sealedMail: true },
			createdAt: now,
		});
		if (recipient) {
			await ctx.db.insert('recipientKeys', {
				address: to,
				domain: to.slice(to.indexOf('@') + 1),
				outcome: recipient.outcome,
				...(recipient.key
					? { pinnedPublicKeyArmored: recipient.key, pinnedFingerprint: 'FP' }
					: {}),
				expiresAt: now + 60_000,
				discoveredAt: now,
				updatedAt: now,
			});
		}
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'u1',
			organizationId: 'o1',
			address: 'alice@a.test',
			domain: 'a.test',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'Sent',
			role: 'sent',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 0,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
		return await ctx.db.insert('mailDrafts', {
			mailboxId,
			toAddresses: [to],
			ccAddresses: [],
			bccAddresses: [],
			fromAddress: 'alice@a.test',
			subject: 'Hello',
			bodyHtml: '<p>Hi Bob</p>',
			attachments: [],
			state: 'pending_send',
			scheduledSendAt: now + 10_000,
			undoToken: 'tok',
			lastEditedAt: now,
			createdAt: now,
		});
	});
}

async function dispatch(t: T, draftId: Id<'mailDrafts'>) {
	await t.action(internal.mail.outbound.dispatchDraft, { draftId, undoToken: 'tok' });
	return await t.run(async (ctx) => ({
		draft: await ctx.db.get(draftId),
		sent: await ctx.db.query('mailMessages').collect(),
	}));
}

describe('mail/outbound · plaintext consent', () => {
	beforeEach(() => {
		vi.stubEnv('INSTANCE_SECRET', 'unit-test-instance-secret-value');
		vi.stubEnv('MTA_INTERNAL_URL', '');
		vi.stubEnv('MTA_API_URL', '');
		vi.stubEnv('MTA_API_KEY', '');
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it('sends mail to a keyless recipient without a consent step', async () => {
		const t = convexTest(schema, modules);
		const draftId = await seedDraft(t, { outcome: 'notFound' });

		const { draft, sent } = await dispatch(t, draftId);

		expect(draft).toBeNull();
		expect(sent).toHaveLength(1);
		expect(sent[0]!.encryptionInfo).toEqual({ isSealed: false, reason: 'recipient_no_key' });
	});

	it('returns a sealable send to the composer when the signing key is missing', async () => {
		const t = convexTest(schema, modules);
		const { publicKey } = await openpgp.generateKey({
			type: 'curve25519',
			userIDs: [{ email: 'bob@b.test' }],
			format: 'armored',
		});
		const draftId = await seedDraft(t, { outcome: 'trusted', key: publicKey });

		const { draft, sent } = await dispatch(t, draftId);

		expect(draft?.state).toBe('draft');
		expect(sent).toHaveLength(0);
	});

	it('looks up a first-time recipient even without a signing key, and asks', async () => {
		// Cold cache, the recipient publishes a key over WKD, the sender cannot
		// sign: this send could have been sealed, so it must not go out in
		// plaintext without consent.
		const bob = 'bob@sealed.example.org';
		const armored = readFileSync(
			new URL('../../../fixtures/sealed-mail/pgp-mime/keys/bob.pub.asc', import.meta.url),
			'utf8'
		);
		const bobBinary = (await openpgp.readKey({ armoredKey: armored })).write();
		vi.stubGlobal('fetch', async (input: string | URL) => {
			const url = new URL(String(input));
			return url.pathname.startsWith('/.well-known/openpgpkey/hu/')
				? new Response(bobBinary.slice(), { status: 200 })
				: new Response(null, { status: 404 });
		});
		const t = convexTest(schema, modules);
		const draftId = await seedDraft(t, null, bob);

		const { draft, sent } = await dispatch(t, draftId);

		expect(draft?.state).toBe('draft');
		expect(sent).toHaveLength(0);
	});
});
