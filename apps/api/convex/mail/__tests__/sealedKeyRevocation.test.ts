/**
 * Sealed Mail (E6) — "Revocation on address deletion" wiring.
 *
 * The card requires that deleting a mailbox or an alias STOPS publishing that
 * address's E2EE key (while retaining the row decrypt-only). This asserts the
 * flag-gated revocation is actually scheduled from BOTH deletion hooks
 * (`mail/mailbox.ts:remove`, `mail/aliases.ts:remove`) — symmetric with the mint
 * the `create` counterparts schedule.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { modules } from './testModules';
import { seedMailbox } from './helpers.testlib';
import { enableSealedMail } from '../../e2ee/__tests__/sealedMailTestHelpers';

// One mutable session drives the `authedMutation` wrapper floors AND the
// in-handler admin / mailbox-access gates (mirrors mailboxAccess.test.ts).
const sessionMock = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'owner' as 'owner' | 'admin' | 'editor' | null,
	orgId: 'org-1',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => {
			if (sessionMock.role === null) throw new Error('Not authenticated');
			return { userId: sessionMock.userId, role: sessionMock.role };
		}),
		getMutationContext: vi.fn(async () => {
			if (sessionMock.role === null) throw new Error('Not authenticated');
			return { userId: sessionMock.userId, role: sessionMock.role };
		}),
		// `mail/mailbox.ts:remove` gates via `requireAdminContext`. Its real body
		// calls the module-sibling `getMutationContext`, which `vi.mock` does NOT
		// intercept for intra-module calls, so mock it directly here.
		requireAdminContext: vi.fn(async () => {
			if (sessionMock.role === null) throw new Error('Not authenticated');
			return { userId: sessionMock.userId, role: sessionMock.role };
		}),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => {
			if (sessionMock.role === null) return null;
			return {
				userId: sessionMock.userId,
				role: sessionMock.role,
				activeOrganizationId: sessionMock.orgId,
			};
		}),
	};
});

describe('Sealed Mail revocation on address deletion', () => {
	beforeEach(() => {
		vi.stubEnv('INSTANCE_SECRET', 'unit-test-instance-secret-value');
		sessionMock.role = 'owner';
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('deleting a mailbox stops publishing its E2EE key', async () => {
		const t = convexTest(schema, modules);
		await enableSealedMail(t);
		const address = 'mailboxdel@hinterland.camp';
		const mailboxId = await seedMailbox(t, { address, domain: 'hinterland.camp' });

		// Mint + publish the address key, then confirm it is discoverable.
		await t.action(internal.e2ee.keysNode.mintForAddress, { address });
		expect(await t.query(api.e2ee.keys.getPublicKeyByAddress, { address })).not.toBeNull();

		vi.useFakeTimers();
		try {
			await t.mutation(api.mail.mailbox.remove, { mailboxId });
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}

		// The public key is no longer served (revoked)...
		expect(await t.query(api.e2ee.keys.getPublicKeyByAddress, { address })).toBeNull();
		// ...but the row is retained decrypt-only rather than deleted.
		const rows = await t.run((ctx) =>
			ctx.db
				.query('keyVault')
				.withIndex('by_address', (q) => q.eq('address', address))
				.collect()
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.isActive).toBe(false);
	});

	it('deleting an alias stops publishing its E2EE key', async () => {
		const t = convexTest(schema, modules);
		await enableSealedMail(t);
		const alias = 'aliasdel@hinterland.camp';
		const mailboxId = await seedMailbox(t, {
			address: 'owner@hinterland.camp',
			domain: 'hinterland.camp',
		});
		const aliasId = await t.run((ctx) =>
			ctx.db.insert('mailAliases', {
				alias,
				targetMailboxId: mailboxId,
				organizationId: 'org-1',
				createdAt: Date.now(),
			})
		);

		await t.action(internal.e2ee.keysNode.mintForAddress, { address: alias });
		expect(await t.query(api.e2ee.keys.getPublicKeyByAddress, { address: alias })).not.toBeNull();

		vi.useFakeTimers();
		try {
			await t.mutation(api.mail.aliases.remove, { aliasId });
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}

		expect(await t.query(api.e2ee.keys.getPublicKeyByAddress, { address: alias })).toBeNull();
	});

	it('leaves the key published when Sealed Mail is off (flag-gated, like the mint)', async () => {
		const t = convexTest(schema, modules);
		// NOTE: sealedMail NOT enabled — deletion must not touch the key.
		const address = 'flagoff@hinterland.camp';
		const mailboxId = await seedMailbox(t, { address, domain: 'hinterland.camp' });
		await t.action(internal.e2ee.keysNode.mintForAddress, { address });

		vi.useFakeTimers();
		try {
			await t.mutation(api.mail.mailbox.remove, { mailboxId });
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}

		// Flag off ⇒ no revocation scheduled ⇒ the key is still active/published.
		expect(await t.query(api.e2ee.keys.getPublicKeyByAddress, { address })).not.toBeNull();
	});
});
