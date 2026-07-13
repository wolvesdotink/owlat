/**
 * Org sealing policy `off` provably prevents sealing at the OUTBOUND layer
 * (Sealed Mail E5 hard gate — asserted end-to-end, not just in the UI).
 *
 * This is the composer-lock honesty audit's server-side counterpart: the E5
 * composer renders "This message won't be sealed" for a `policy_off` draft, and
 * THIS test proves the sender actually keeps its word. With `sealPolicy: 'off'`,
 * a fully sealable draft — a vault signing key for the From address AND a trusted
 * recipient with a usable pinned key — is dispatched through the REAL
 * `dispatchDraft` action, and the bytes stored at the sent row must be PLAINTEXT
 * (the canary survives, no PGP/MIME envelope) with `encryptionInfo` recording the
 * honest `{ sealed: false, reason: 'policy_off' }`.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as openpgp from 'openpgp';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from './testModules';
import { readSealedBlobBytes } from '../../lib/sealedBlob';

const INSTANCE_SECRET = 'unit-test-instance-secret-value';
const SEALED_FLAGS = { postbox: true, senderAuthBadges: true, sealedMail: true };

type T = ReturnType<typeof convexTest>;

async function generatePublicKey(email: string): Promise<string> {
	const { publicKey } = await openpgp.generateKey({
		type: 'curve25519',
		userIDs: [{ name: email, email }],
		format: 'armored',
	});
	return publicKey;
}

describe('mail/outbound · sealPolicy "off" keeps the STORED bytes plaintext (E5)', () => {
	beforeEach(() => {
		vi.stubEnv('INSTANCE_SECRET', INSTANCE_SECRET);
		// No MTA transport: dispatchDraft still stores the `.eml` and runs the sent
		// cascade, it just POSTs nothing — exactly the branch we assert on.
		vi.stubEnv('MTA_INTERNAL_URL', '');
		vi.stubEnv('MTA_API_URL', '');
		vi.stubEnv('MTA_API_KEY', '');
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('a fully sealable draft goes out plaintext when the org policy is off', async () => {
		const t: T = convexTest(schema, modules);
		const CANARY = 'CANARY_POLICY_OFF_e5c0ffee';

		// policy OFF — the ONLY thing standing between this draft and a seal.
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: SEALED_FLAGS,
				sealPolicy: 'off',
				createdAt: Date.now(),
			});
		});
		// A real signing key + a trusted recipient with a usable pinned key: absent
		// the policy this draft WOULD seal, so a pass proves the policy is the gate.
		await t.action(internal.e2ee.keysNode.mintForAddress, { address: 'alice@a.test' });
		const recipientKey = await generatePublicKey('bob@b.test');
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('recipientKeys', {
				address: 'bob@b.test',
				domain: 'b.test',
				outcome: 'trusted',
				pinnedFingerprint: 'FP',
				pinnedPublicKeyArmored: recipientKey,
				expiresAt: now + 60_000,
				discoveredAt: now,
				updatedAt: now,
			});
		});

		const draftId = await t.run(async (ctx) => {
			const now = Date.now();
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
				toAddresses: ['bob@b.test'],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'alice@a.test',
				subject: `Confidential ${CANARY}`,
				bodyHtml: `<p>the ${CANARY} body</p>`,
				attachments: [],
				state: 'pending_send',
				scheduledSendAt: now + 10_000,
				undoToken: 'tok-off',
				lastEditedAt: now,
				createdAt: now,
			});
		});

		await t.action(internal.mail.outbound.dispatchDraft, { draftId, undoToken: 'tok-off' });

		const { storedText, encryptionInfo } = await t.run(async (ctx) => {
			const rows = await ctx.db.query('mailMessages').collect();
			const sent = rows[0];
			if (!sent) throw new Error('dispatchDraft stored no sent mailMessages row');
			// E8b seals the stored `.eml` blob at rest; unseal that layer so the
			// plaintext-`.eml` assertions below see the real (unsealed-policy) bytes.
			const rawBytes = await readSealedBlobBytes(ctx.storage, sent.rawStorageId);
			return {
				storedText: rawBytes ? new TextDecoder().decode(rawBytes) : '',
				encryptionInfo: sent.encryptionInfo as { sealed: boolean; reason?: string } | undefined,
			};
		});

		// The stored bytes are the plaintext message, not a PGP/MIME envelope.
		expect(storedText).toContain(CANARY);
		expect(storedText).not.toContain('multipart/encrypted; protocol="application/pgp-encrypted"');
		// And the row honestly records WHY it wasn't sealed.
		expect(encryptionInfo).toEqual({ sealed: false, reason: 'policy_off' });
	});
});
