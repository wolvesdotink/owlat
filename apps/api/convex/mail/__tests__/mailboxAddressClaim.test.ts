/**
 * One rule for "is this address taken" (`findAddressClaim`) and one resolver for
 * "which mailbox owns this address" (`resolveDeliverableMailbox`), both in
 * `mail/mailbox/addressResolution.ts`.
 *
 * Pins the rule itself (every row claims its address except a soft-deleted
 * external one), the connect paths that used to count only ACTIVE rows (so a
 * suspended or removed hosted mailbox no longer lets a second row onto its
 * address), the personal reconnect that the soft-deleted external exemption
 * exists for, and the agent-draft voice lookup that used to take the oldest row.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';
import { modules, seedMailbox } from './helpers.testlib';
import { enableFeatures } from '../../__tests__/factories';
import {
	findAddressClaim,
	listMailboxesOnAddress,
	resolveDeliverableMailbox,
} from '../mailbox/addressResolution';

const sessionMock = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'admin' as 'owner' | 'admin' | 'editor' | null,
	orgId: 'org-1',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = () => {
		if (sessionMock.role === null) throw new Error('Not authenticated');
		return {
			userId: sessionMock.userId,
			role: sessionMock.role,
			activeOrganizationId: sessionMock.orgId,
		};
	};
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session()),
		getMutationContext: vi.fn(async () => session()),
		requireOrgPermission: vi.fn(async () => session()),
		requireAdminContext: vi.fn(async () => {
			const s = session();
			if (s.role !== 'owner' && s.role !== 'admin') {
				throw new Error('Only owners and admins can perform this action');
			}
			return s;
		}),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => (sessionMock.role === null ? null : session())),
	};
});

const ADDRESS = 'me@acme.test';

const CREDS = {
	emailAddress: ADDRESS,
	imapHost: 'imap.acme.test',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.acme.test',
	smtpPort: 465,
	isSmtpSecure: true,
	imapUsername: ADDRESS,
	authMethod: 'password' as const,
	secretCiphertext: 'ct',
	secretIv: 'iv',
	secretAuthTag: 'tag',
	secretEnvelopeVersion: 1,
};

function seedOnAddress(
	t: TestConvex<typeof schema>,
	seed: {
		status: 'active' | 'suspended' | 'deleted';
		kind: 'hosted' | 'external';
		userId?: string;
	}
): Promise<Id<'mailboxes'>> {
	return seedMailbox(t, {
		address: ADDRESS,
		domain: 'acme.test',
		userId: seed.userId ?? 'someone-else',
		status: seed.status,
		kind: seed.kind,
	});
}

describe('findAddressClaim', () => {
	it.each([
		{ status: 'active', kind: 'hosted', claims: true },
		{ status: 'suspended', kind: 'hosted', claims: true },
		{ status: 'deleted', kind: 'hosted', claims: true },
		{ status: 'active', kind: 'external', claims: true },
		{ status: 'suspended', kind: 'external', claims: true },
		{ status: 'deleted', kind: 'external', claims: false },
	] as const)('a $status $kind mailbox claims the address: $claims', async (row) => {
		const t = convexTest(schema, modules);
		const id = await seedOnAddress(t, row);
		const claim = await t.run((ctx) => findAddressClaim(ctx, ADDRESS));
		expect(claim?._id ?? null).toBe(row.claims ? id : null);
	});

	it('finds nothing on an address without rows', async () => {
		const t = convexTest(schema, modules);
		expect(await t.run((ctx) => findAddressClaim(ctx, ADDRESS))).toBeNull();
	});

	it('looks past a soft-deleted external remnant to a claiming row behind it', async () => {
		const t = convexTest(schema, modules);
		await seedOnAddress(t, { status: 'deleted', kind: 'external' });
		const hosted = await seedOnAddress(t, { status: 'suspended', kind: 'hosted' });
		const claim = await t.run((ctx) => findAddressClaim(ctx, ADDRESS));
		expect(claim?._id).toBe(hosted);
	});
});

describe('resolveDeliverableMailbox', () => {
	it('prefers the hosted successor over the external archive a move leaves', async () => {
		const t = convexTest(schema, modules);
		const archive = await seedOnAddress(t, { status: 'active', kind: 'external' });
		const hosted = await seedOnAddress(t, { status: 'active', kind: 'hosted' });
		const rows = await t.run((ctx) => listMailboxesOnAddress(ctx, ADDRESS));
		expect(rows.map((r) => r._id)).toEqual([archive, hosted]);
		const resolved = await t.run((ctx) => resolveDeliverableMailbox(ctx, ADDRESS));
		expect(resolved?._id).toBe(hosted);
	});

	it('resolves nothing when every row on the address is inactive', async () => {
		const t = convexTest(schema, modules);
		await seedOnAddress(t, { status: 'suspended', kind: 'hosted' });
		await seedOnAddress(t, { status: 'deleted', kind: 'external' });
		expect(await t.run((ctx) => resolveDeliverableMailbox(ctx, ADDRESS))).toBeNull();
	});
});

describe('external connect over a claimed address', () => {
	const refusal = `A mailbox for ${ADDRESS} already exists.`;

	it.each(['suspended', 'deleted'] as const)(
		'refuses a personal connect over a %s hosted mailbox',
		async (status) => {
			const t = convexTest(schema, modules);
			await seedOnAddress(t, { status, kind: 'hosted' });
			sessionMock.userId = 'user-A';
			sessionMock.role = 'editor';
			await expect(
				t.mutation(internal.mail.external.accounts._connectInternal, CREDS)
			).rejects.toThrow(refusal);
		}
	);

	it.each(['suspended', 'deleted'] as const)(
		'refuses a team inbox connect over a %s hosted mailbox',
		async (status) => {
			const t = convexTest(schema, modules);
			await seedOnAddress(t, { status, kind: 'hosted' });
			sessionMock.userId = 'admin-user';
			sessionMock.role = 'admin';
			await expect(
				t.mutation(internal.mail.external.sharedInbox._connectSharedInternal, {
					...CREDS,
					memberUserIds: [],
				})
			).rejects.toThrow(refusal);
		}
	);

	it.each(['suspended', 'deleted'] as const)(
		'refuses a seed connect over a %s hosted mailbox',
		async (status) => {
			const t = convexTest(schema, modules);
			await seedOnAddress(t, { status, kind: 'hosted' });
			sessionMock.userId = 'admin-user';
			sessionMock.role = 'admin';
			await expect(
				t.mutation(internal.mail.external.accountsSeed._connectSeedInternal, {
					...CREDS,
					seedProvider: 'gmail',
				})
			).rejects.toThrow(refusal);
		}
	);

	it('re-opens the mailbox a personal disconnect kept instead of refusing it', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		sessionMock.userId = 'user-A';
		sessionMock.role = 'editor';
		const first = await t.mutation(internal.mail.external.accounts._connectInternal, CREDS);
		await t.mutation(api.mail.external.accounts.disconnect, {});
		const kept = await t.run((ctx) => ctx.db.get(first.mailboxId));
		expect(kept?.status).toBe('deleted');

		const again = await t.mutation(internal.mail.external.accounts._connectInternal, CREDS);
		expect(again.mailboxId).toBe(first.mailboxId);
		expect(again.externalAccountId).toBe(first.externalAccountId);
		const rows = await t.run((ctx) => listMailboxesOnAddress(ctx, ADDRESS));
		expect(rows.map((r) => [r._id, r.status])).toEqual([[first.mailboxId, 'active']]);
	});

	it("still refuses someone else's connect while the address is live", async () => {
		const t = convexTest(schema, modules);
		await seedOnAddress(t, { status: 'active', kind: 'external', userId: 'user-B' });
		sessionMock.userId = 'user-A';
		sessionMock.role = 'editor';
		await expect(
			t.mutation(internal.mail.external.accounts._connectInternal, CREDS)
		).rejects.toThrow(refusal);
	});
});

describe('other writers share the rule', () => {
	it('refuses an alias on the address of a suspended mailbox', async () => {
		const t = convexTest(schema, modules);
		const own = await seedMailbox(t, { userId: 'user-A', address: 'a@acme.test' });
		await seedOnAddress(t, { status: 'suspended', kind: 'hosted' });
		sessionMock.userId = 'user-A';
		sessionMock.role = 'editor';
		await expect(
			t.mutation(api.mail.aliases.create, { mailboxId: own, alias: ADDRESS })
		).rejects.toThrow('A mailbox already exists at that address');
	});

	it('lets an admin create a hosted mailbox over a soft-deleted external remnant', async () => {
		const t = convexTest(schema, modules);
		await seedOnAddress(t, { status: 'deleted', kind: 'external' });
		sessionMock.userId = 'admin-user';
		sessionMock.role = 'admin';
		const id = await t.mutation(api.mail.mailbox.identity.create, {
			userId: 'user-A',
			address: `Me <${ADDRESS.toUpperCase()}>`,
		});
		const created = await t.run((ctx) => ctx.db.get(id));
		expect(created?.address).toBe(ADDRESS);
		expect(created?.kind).toBe('hosted');
	});

	it('still refuses a hosted create over a soft-deleted hosted mailbox', async () => {
		const t = convexTest(schema, modules);
		await seedOnAddress(t, { status: 'deleted', kind: 'hosted' });
		sessionMock.userId = 'admin-user';
		sessionMock.role = 'admin';
		await expect(
			t.mutation(api.mail.mailbox.identity.create, { userId: 'user-A', address: ADDRESS })
		).rejects.toThrow(`Mailbox ${ADDRESS} already exists`);
	});
});

describe('voice guidance for an agent draft', () => {
	async function seedVoice(
		t: TestConvex<typeof schema>,
		mailboxId: Id<'mailboxes'>,
		instruction: string
	): Promise<void> {
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('mailVoiceProfiles', {
				mailboxId,
				isEnabled: true,
				status: 'idle',
				sampleCount: 0,
				sentCountAtCompute: 0,
				standingInstructions: [instruction],
				createdAt: now,
				updatedAt: now,
			});
		});
	}

	it("reads the live hosted mailbox's voice, not the external archive's", async () => {
		const t = convexTest(schema, modules);
		const archive = await seedOnAddress(t, { status: 'active', kind: 'external' });
		const hosted = await seedOnAddress(t, { status: 'active', kind: 'hosted' });
		await seedVoice(t, archive, 'archive rule');
		await seedVoice(t, hosted, 'hosted rule');
		const { guidance } = await t.mutation(internal.mail.ai.voiceProfile.getGuidanceForRecipient, {
			recipient: `Me <${ADDRESS}>`,
		});
		expect(guidance).toContain('hosted rule');
		expect(guidance).not.toContain('archive rule');
	});

	it('gives no guidance from a soft-deleted mailbox', async () => {
		const t = convexTest(schema, modules);
		const removed = await seedOnAddress(t, { status: 'deleted', kind: 'hosted' });
		await seedVoice(t, removed, 'removed rule');
		const { guidance } = await t.mutation(internal.mail.ai.voiceProfile.getGuidanceForRecipient, {
			recipient: ADDRESS,
		});
		expect(guidance).toBeNull();
	});
});
