/**
 * Integration tests for the app-password credential module
 * (apps/api/convex/mail/appPasswords.ts).
 *
 * App passwords back native IMAP/SMTP clients. The module's security
 * contract is:
 *   - generate: returns the cleartext exactly ONCE; persists only a
 *     PBKDF2 hash (encoded `<salt-hex>:<hash-hex>`) plus a 4-char lowercase
 *     prefix — never the cleartext. Bound to the mailbox + owning user.
 *   - verify (internalAction, used by the IMAP/SMTP submission paths): a
 *     correct (address, password, scope) triple resolves to the bound
 *     mailbox/owner/org; a wrong password, a revoked credential, an
 *     unknown address, an out-of-scope credential, or a throttled caller
 *     all return null (indistinguishable to the caller).
 *   - revoke: owner/admin or the mailbox's own user only.
 *   - revokeAll: admin-gated (owner/admin) emergency revoke for a mailbox.
 *
 * We drive the public mutations through `t.mutation`/`t.query` and mock
 * `getBetterAuthSessionWithRole` (the single session choke point that both
 * `requireMailboxAccess` and `requireAdminContext` resolve through) so the REAL
 * permission logic runs against a parameterized session. `verify` needs no
 * session; it runs the real internal query/mutation against seeded rows, so
 * we register the rate-limiter component it shares with the throttle table.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import rateLimiterTest from '@convex-dev/rate-limiter/test';

// Mutable session the mock resolves to. Tests flip role / userId / org to
// exercise owner-vs-admin-vs-editor and ownership boundaries.
const sessionMock = vi.hoisted(() => ({
	value: {
		userId: 'user-owner',
		activeOrganizationId: 'org-1',
		role: 'owner' as 'owner' | 'admin' | 'editor' | null,
	} as {
		userId: string;
		activeOrganizationId: string | null;
		role: 'owner' | 'admin' | 'editor' | null;
	} | null,
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = (await vi.importActual('../lib/sessionOrganization')) as {
		hasPermission: (r: string, p: string) => boolean;
	};
	const errors = (await vi.importActual('../_utils/errors')) as {
		throwUnauthenticated: () => never;
		throwForbidden: (m?: string) => never;
	};
	// All gated paths are resolved from the SAME mutable session so one knob
	// drives them. We mock the public choke points the code actually imports —
	// note `requireOrgMember`'s INTERNAL call to `getBetterAuthSessionWithRole`
	// is not interceptable, so the wrapper's `getMutationContext` and
	// `requireMailboxAccess`'s `getBetterAuthSessionWithRole` must both be stubbed.
	const ctxFromSession = () => {
		const s = sessionMock.value;
		if (!s || !s.role || !s.activeOrganizationId) errors.throwUnauthenticated();
		return { userId: s!.userId, role: s!.role };
	};
	return {
		...actual,
		// Used by requireMailboxAccess (permissions.ts) — needs the full shape.
		getBetterAuthSessionWithRole: vi.fn().mockImplementation(async () => sessionMock.value),
		// Used by the authedMutation wrapper. Floors on membership only.
		getMutationContext: vi.fn().mockImplementation(async () => ctxFromSession()),
		requireOrgMember: vi.fn().mockImplementation(async () => ctxFromSession()),
		// Used by revokeAll. Runs the real owner/admin permission predicate.
		requireAdminContext: vi.fn().mockImplementation(async () => {
			const c = ctxFromSession();
			if (!actual.hasPermission(c.role as string, 'organization:manage')) {
				errors.throwForbidden('Only owners and admins can perform this action');
			}
			return c;
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([p]) =>
			!p.includes('sesActions') &&
			!p.includes('agentSecurity') &&
			!p.includes('agentContext') &&
			!p.includes('agentClassifier') &&
			!p.includes('agentDrafter') &&
			!p.includes('agentRouter') &&
			!p.includes('agent/walker') &&
			!p.includes('agent/steps/index') &&
			!p.includes('agent/steps/shared') &&
			!p.includes('agent/steps/classify') &&
			!p.includes('agent/steps/draft') &&
			!p.includes('knowledgeExtraction') &&
			!p.includes('semanticFileProcessing') &&
			!p.includes('visualizationAgent') &&
			!p.includes('llmProvider')
	)
);

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

const setSession = (
	userId: string,
	role: 'owner' | 'admin' | 'editor' | null,
	activeOrganizationId: string | null = 'org-1'
) => {
	sessionMock.value =
		role === null && userId === '' ? null : { userId, activeOrganizationId, role };
};

// Seed a mailbox; returns its id (and the owning userId for convenience).
async function seedMailbox(
	t: ReturnType<typeof setupTest>,
	overrides: {
		userId?: string;
		address?: string;
		organizationId?: string;
		status?: 'active' | 'suspended' | 'deleted';
	} = {}
) {
	const userId = overrides.userId ?? 'user-owner';
	const address = overrides.address ?? 'mailbox@example.com';
	const organizationId = overrides.organizationId ?? 'org-1';
	const status = overrides.status ?? 'active';
	const mailboxId = await t.run(async (ctx) =>
		ctx.db.insert('mailboxes', {
			userId,
			organizationId,
			address,
			domain: address.split('@')[1] ?? 'example.com',
			status,
			usedBytes: 0,
			uidValidity: Date.now(),
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	);
	return { mailboxId, userId, address, organizationId };
}

beforeEach(() => {
	setSession('user-owner', 'owner', 'org-1');
});

// ─── generate ──────────────────────────────────────────────────────────────

describe('appPasswords.generate', () => {
	it('returns the cleartext once and persists only a hash + prefix (no cleartext)', async () => {
		const t = setupTest();
		const { mailboxId } = await seedMailbox(t);

		const result = await t.mutation(api.mail.appPasswords.generate, {
			mailboxId,
			label: 'iPhone Mail',
		});

		expect(result.id).toBeDefined();
		expect(typeof result.cleartext).toBe('string');
		// 16-char base32 password.
		expect(result.cleartext).toHaveLength(16);
		expect(result.cleartext).toMatch(/^[A-Z2-9]{16}$/);

		await t.run(async (ctx) => {
			const row = await ctx.db.get(result.id);
			expect(row).not.toBeNull();
			// Cleartext is NOT persisted anywhere on the row.
			expect(JSON.stringify(row)).not.toContain(result.cleartext);
			// Hash is the PBKDF2 `<salt-hex>:<hash-hex>` envelope.
			expect(row!.passwordHash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
			expect(row!.passwordHash).not.toBe(result.cleartext);
			// Prefix is the first 4 chars, lowercased.
			expect(row!.passwordPrefix).toBe(result.cleartext.slice(0, 4).toLowerCase());
		});
	});

	it('associates the new credential with the mailbox and owning user', async () => {
		const t = setupTest();
		const { mailboxId, userId } = await seedMailbox(t);

		const result = await t.mutation(api.mail.appPasswords.generate, {
			mailboxId,
			label: 'Thunderbird',
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.get(result.id);
			expect(row!.mailboxId).toBe(mailboxId);
			expect(row!.userId).toBe(userId);
			expect(row!.label).toBe('Thunderbird');
			expect(row!.revokedAt).toBeUndefined();
		});
	});

	it('defaults scopes to both imap and smtp when omitted', async () => {
		const t = setupTest();
		const { mailboxId } = await seedMailbox(t);

		const result = await t.mutation(api.mail.appPasswords.generate, {
			mailboxId,
			label: 'Default scopes',
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.get(result.id);
			expect([...row!.scopes].sort()).toEqual(['imap', 'smtp']);
		});
	});

	it('honors an explicit single scope', async () => {
		const t = setupTest();
		const { mailboxId } = await seedMailbox(t);

		const result = await t.mutation(api.mail.appPasswords.generate, {
			mailboxId,
			label: 'IMAP only',
			scopes: ['imap'],
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.get(result.id);
			expect(row!.scopes).toEqual(['imap']);
		});
	});

	it('trims the label and rejects a blank one', async () => {
		const t = setupTest();
		const { mailboxId } = await seedMailbox(t);

		const trimmed = await t.mutation(api.mail.appPasswords.generate, {
			mailboxId,
			label: '  Padded Label  ',
		});
		await t.run(async (ctx) => {
			const row = await ctx.db.get(trimmed.id);
			expect(row!.label).toBe('Padded Label');
		});

		await expect(
			t.mutation(api.mail.appPasswords.generate, {
				mailboxId,
				label: '   ',
			})
		).rejects.toThrow();
	});

	it('forbids generating for a mailbox the caller does not own (editor, not their mailbox)', async () => {
		const t = setupTest();
		// Mailbox owned by someone else.
		const { mailboxId } = await seedMailbox(t, { userId: 'user-other' });
		// Caller is an editor (not owner/admin) and not the mailbox owner.
		setSession('user-editor', 'editor');

		await expect(
			t.mutation(api.mail.appPasswords.generate, {
				mailboxId,
				label: 'Should fail',
			})
		).rejects.toThrow(/not accessible/i);
	});

	it('allows an admin to generate for another user’s mailbox (acts org-wide)', async () => {
		const t = setupTest();
		const { mailboxId } = await seedMailbox(t, { userId: 'user-other' });
		setSession('user-admin', 'admin');

		const result = await t.mutation(api.mail.appPasswords.generate, {
			mailboxId,
			label: 'Admin-created',
		});
		expect(result.cleartext).toHaveLength(16);
		await t.run(async (ctx) => {
			const row = await ctx.db.get(result.id);
			// Bound to the acting (admin) user per requireMailboxAccess.userId.
			expect(row!.userId).toBe('user-admin');
		});
	});

	it('rejects generation against a non-active mailbox', async () => {
		const t = setupTest();
		const { mailboxId } = await seedMailbox(t, { status: 'suspended' });

		await expect(
			t.mutation(api.mail.appPasswords.generate, {
				mailboxId,
				label: 'Suspended',
			})
		).rejects.toThrow(/not accessible/i);
	});
});

// ─── verify ──────────────────────────────────────────────────────────────

describe('appPasswords.verify', () => {
	// Generate a credential and hand back the cleartext + ids.
	async function provision(
		t: ReturnType<typeof setupTest>,
		opts: { scopes?: ('imap' | 'smtp')[]; address?: string } = {}
	) {
		const address = opts.address ?? 'mailbox@example.com';
		const { mailboxId, userId, organizationId } = await seedMailbox(t, { address });
		const result = await t.mutation(api.mail.appPasswords.generate, {
			mailboxId,
			label: 'verify-fixture',
			scopes: opts.scopes,
		});
		return {
			mailboxId,
			userId,
			organizationId,
			address,
			appPasswordId: result.id,
			cleartext: result.cleartext,
		};
	}

	it('resolves the bound mailbox/owner/org for a correct imap credential', async () => {
		const t = setupTest();
		const f = await provision(t);

		const res = await t.action(internal.mail.appPasswords.verify, {
			address: f.address,
			password: f.cleartext,
			scope: 'imap',
		});

		expect(res).not.toBeNull();
		expect(res!.mailboxId).toBe(f.mailboxId);
		expect(res!.appPasswordId).toBe(f.appPasswordId);
		expect(res!.userId).toBe(f.userId);
		expect(res!.organizationId).toBe(f.organizationId);
	});

	it('resolves correctly for the smtp scope as well', async () => {
		const t = setupTest();
		const f = await provision(t);

		const res = await t.action(internal.mail.appPasswords.verify, {
			address: f.address,
			password: f.cleartext,
			scope: 'smtp',
		});
		expect(res).not.toBeNull();
		expect(res!.appPasswordId).toBe(f.appPasswordId);
	});

	it('matches the address case-insensitively', async () => {
		const t = setupTest();
		const f = await provision(t, { address: 'mailbox@example.com' });

		const res = await t.action(internal.mail.appPasswords.verify, {
			address: 'MailBox@Example.COM',
			password: f.cleartext,
			scope: 'imap',
		});
		expect(res).not.toBeNull();
		expect(res!.mailboxId).toBe(f.mailboxId);
	});

	it('returns null for a wrong password', async () => {
		const t = setupTest();
		const f = await provision(t);

		const res = await t.action(internal.mail.appPasswords.verify, {
			// Same prefix as the real one (so it survives prefix narrowing) but
			// a different tail — must still fail the hash compare.
			address: f.address,
			password: f.cleartext.slice(0, 4) + 'ZZZZZZZZZZZZ',
			scope: 'imap',
		});
		expect(res).toBeNull();
	});

	it('returns null for a totally unknown password (no prefix match)', async () => {
		const t = setupTest();
		const f = await provision(t);

		const res = await t.action(internal.mail.appPasswords.verify, {
			address: f.address,
			password: 'lowercasebogus99',
			scope: 'imap',
		});
		expect(res).toBeNull();
	});

	it('returns null for an unknown address', async () => {
		const t = setupTest();
		const f = await provision(t);

		const res = await t.action(internal.mail.appPasswords.verify, {
			address: 'nobody@example.com',
			password: f.cleartext,
			scope: 'imap',
		});
		expect(res).toBeNull();
	});

	it('returns null when the credential lacks the requested scope', async () => {
		const t = setupTest();
		// IMAP-only credential.
		const f = await provision(t, { scopes: ['imap'] });

		const smtp = await t.action(internal.mail.appPasswords.verify, {
			address: f.address,
			password: f.cleartext,
			scope: 'smtp',
		});
		expect(smtp).toBeNull();

		// But imap still works.
		const imap = await t.action(internal.mail.appPasswords.verify, {
			address: f.address,
			password: f.cleartext,
			scope: 'imap',
		});
		expect(imap).not.toBeNull();
	});

	it('returns null for a revoked credential', async () => {
		const t = setupTest();
		const f = await provision(t);

		// Owner revokes it.
		await t.mutation(api.mail.appPasswords.revoke, { appPasswordId: f.appPasswordId });

		const res = await t.action(internal.mail.appPasswords.verify, {
			address: f.address,
			password: f.cleartext,
			scope: 'imap',
		});
		expect(res).toBeNull();
	});

	it('returns null when the mailbox is not active', async () => {
		const t = setupTest();
		const f = await provision(t);

		await t.run(async (ctx) => {
			await ctx.db.patch(f.mailboxId, { status: 'suspended' });
		});

		const res = await t.action(internal.mail.appPasswords.verify, {
			address: f.address,
			password: f.cleartext,
			scope: 'imap',
		});
		expect(res).toBeNull();
	});

	it('returns null (looks like a failure) when the per-address throttle trips', async () => {
		const t = setupTest();
		const f = await provision(t);

		// Pile up enough recent failures to cross the per-address window limit
		// (PER_ADDRESS_LIMIT = 5). isThrottled then short-circuits verify to null
		// even though the password is correct.
		await t.run(async (ctx) => {
			const now = Date.now();
			for (let i = 0; i < 6; i++) {
				await ctx.db.insert('mailAuthFailures', {
					address: f.address.toLowerCase(),
					scope: 'imap',
					occurredAt: now,
				});
			}
		});

		const res = await t.action(internal.mail.appPasswords.verify, {
			address: f.address,
			password: f.cleartext,
			scope: 'imap',
		});
		expect(res).toBeNull();
	});

	it('records an auth-failure row on a wrong-password attempt', async () => {
		const t = setupTest();
		const f = await provision(t);

		const before = await t.run(
			async (ctx) => (await ctx.db.query('mailAuthFailures').collect()).length
		);

		await t.action(internal.mail.appPasswords.verify, {
			address: f.address,
			password: f.cleartext.slice(0, 4) + 'WRONGWRONGWRO',
			scope: 'imap',
			ip: '203.0.113.7',
		});

		const after = await t.run(
			async (ctx) => (await ctx.db.query('mailAuthFailures').collect()).length
		);
		expect(after).toBe(before + 1);
	});
});

// ─── touch (last-used recording) ─────────────────────────────────────────

describe('appPasswords.touch', () => {
	async function seedCredential(t: ReturnType<typeof setupTest>) {
		const { mailboxId } = await seedMailbox(t);
		const appPasswordId = await t.run(async (ctx) =>
			ctx.db.insert('mailAppPasswords', {
				mailboxId,
				userId: 'user-owner',
				label: 'touch-fixture',
				passwordHash: 'aa:bb',
				passwordPrefix: 'abcd',
				scopes: ['imap', 'smtp'],
				createdAt: Date.now(),
			})
		);
		return { mailboxId, appPasswordId };
	}

	it('records lastUsedAt/IP/UA and list surfaces the user agent', async () => {
		const t = setupTest();
		const { mailboxId, appPasswordId } = await seedCredential(t);

		await t.mutation(internal.mail.appPasswords.touch, {
			appPasswordId,
			ip: '203.0.113.9',
			userAgent: 'Thunderbird',
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.get(appPasswordId);
			expect(row!.lastUsedAt).toBeGreaterThan(0);
			expect(row!.lastUsedIp).toBe('203.0.113.9');
			expect(row!.lastUsedUa).toBe('Thunderbird');
		});

		// The admin list query must surface the recorded user agent so the UA
		// column is no longer permanently empty.
		const rows = await t.query(api.mail.appPasswords.list, { mailboxId });
		const row = rows.find((r) => r._id === appPasswordId);
		expect(row?.lastUsedUa).toBe('Thunderbird');
	});

	it('leaves lastUsedUa undefined when no user agent is supplied', async () => {
		const t = setupTest();
		const { appPasswordId } = await seedCredential(t);

		await t.mutation(internal.mail.appPasswords.touch, {
			appPasswordId,
			ip: '203.0.113.9',
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.get(appPasswordId);
			expect(row!.lastUsedAt).toBeGreaterThan(0);
			expect(row!.lastUsedUa).toBeUndefined();
		});
	});

	it('is a no-op for a revoked credential', async () => {
		const t = setupTest();
		const { appPasswordId } = await seedCredential(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(appPasswordId, { revokedAt: Date.now() });
		});

		await t.mutation(internal.mail.appPasswords.touch, {
			appPasswordId,
			ip: '203.0.113.9',
			userAgent: 'Thunderbird',
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.get(appPasswordId);
			expect(row!.lastUsedAt).toBeUndefined();
			expect(row!.lastUsedUa).toBeUndefined();
		});
	});
});

// ─── revoke ──────────────────────────────────────────────────────────────

describe('appPasswords.revoke', () => {
	async function seedCredential(t: ReturnType<typeof setupTest>, mailboxOwner = 'user-owner') {
		const { mailboxId } = await seedMailbox(t, { userId: mailboxOwner });
		const appPasswordId = await t.run(async (ctx) =>
			ctx.db.insert('mailAppPasswords', {
				mailboxId,
				userId: mailboxOwner,
				label: 'to-revoke',
				passwordHash: 'aa:bb',
				passwordPrefix: 'abcd',
				scopes: ['imap', 'smtp'],
				createdAt: Date.now(),
			})
		);
		return { mailboxId, appPasswordId };
	}

	it('lets the mailbox owner revoke (sets revokedAt)', async () => {
		const t = setupTest();
		const { appPasswordId } = await seedCredential(t, 'user-owner');
		// Caller IS the mailbox's own user (role editor, but matches userId).
		setSession('user-owner', 'editor');

		await t.mutation(api.mail.appPasswords.revoke, { appPasswordId });

		await t.run(async (ctx) => {
			const row = await ctx.db.get(appPasswordId);
			expect(row!.revokedAt).toBeGreaterThan(0);
		});
	});

	it('lets an org admin revoke a credential on another user’s mailbox', async () => {
		const t = setupTest();
		const { appPasswordId } = await seedCredential(t, 'user-other');
		setSession('user-admin', 'admin');

		await t.mutation(api.mail.appPasswords.revoke, { appPasswordId });

		await t.run(async (ctx) => {
			const row = await ctx.db.get(appPasswordId);
			expect(row!.revokedAt).toBeGreaterThan(0);
		});
	});

	it('forbids a non-owner editor from revoking someone else’s credential', async () => {
		const t = setupTest();
		const { appPasswordId } = await seedCredential(t, 'user-other');
		// Editor who is neither owner/admin nor the mailbox owner.
		setSession('user-editor', 'editor');

		await expect(t.mutation(api.mail.appPasswords.revoke, { appPasswordId })).rejects.toThrow(
			/not accessible/i
		);

		await t.run(async (ctx) => {
			const row = await ctx.db.get(appPasswordId);
			expect(row!.revokedAt).toBeUndefined();
		});
	});

	it('is a no-op for an unknown credential id', async () => {
		const t = setupTest();
		const { appPasswordId } = await seedCredential(t, 'user-owner');
		// Delete it so the id is dangling, then revoke — must not throw.
		await t.run(async (ctx) => {
			await ctx.db.delete(appPasswordId);
		});

		// `revoke` returns early (no throw); Convex serializes the void return
		// to null.
		await expect(t.mutation(api.mail.appPasswords.revoke, { appPasswordId })).resolves.toBeNull();
	});
});

// ─── revokeAll (admin-gated) ─────────────────────────────────────────────

describe('appPasswords.revokeAll', () => {
	async function seedMany(t: ReturnType<typeof setupTest>) {
		const { mailboxId } = await seedMailbox(t, { userId: 'user-other' });
		const ids = await t.run(async (ctx) => {
			const a = await ctx.db.insert('mailAppPasswords', {
				mailboxId,
				userId: 'user-other',
				label: 'one',
				passwordHash: 'aa:bb',
				passwordPrefix: 'aaaa',
				scopes: ['imap', 'smtp'],
				createdAt: Date.now(),
			});
			const b = await ctx.db.insert('mailAppPasswords', {
				mailboxId,
				userId: 'user-other',
				label: 'two',
				passwordHash: 'cc:dd',
				passwordPrefix: 'bbbb',
				scopes: ['imap'],
				createdAt: Date.now(),
			});
			// Already-revoked row — should keep its original revokedAt.
			const c = await ctx.db.insert('mailAppPasswords', {
				mailboxId,
				userId: 'user-other',
				label: 'already',
				passwordHash: 'ee:ff',
				passwordPrefix: 'cccc',
				scopes: ['smtp'],
				createdAt: Date.now(),
				revokedAt: 111,
			});
			return { a, b, c };
		});
		return { mailboxId, ids };
	}

	it('revokes every active credential for the mailbox when an admin calls it', async () => {
		const t = setupTest();
		const { mailboxId, ids } = await seedMany(t);
		setSession('user-admin', 'admin');

		await t.mutation(api.mail.appPasswords.revokeAll, { mailboxId });

		await t.run(async (ctx) => {
			const a = await ctx.db.get(ids.a);
			const b = await ctx.db.get(ids.b);
			const c = await ctx.db.get(ids.c);
			expect(a!.revokedAt).toBeGreaterThan(0);
			expect(b!.revokedAt).toBeGreaterThan(0);
			// Pre-revoked row's timestamp is left untouched.
			expect(c!.revokedAt).toBe(111);
		});
	});

	it('lets an owner call revokeAll', async () => {
		const t = setupTest();
		const { mailboxId, ids } = await seedMany(t);
		setSession('user-owner', 'owner');

		await t.mutation(api.mail.appPasswords.revokeAll, { mailboxId });

		await t.run(async (ctx) => {
			expect((await ctx.db.get(ids.a))!.revokedAt).toBeGreaterThan(0);
		});
	});

	it('forbids an editor from calling revokeAll', async () => {
		const t = setupTest();
		const { mailboxId, ids } = await seedMany(t);
		setSession('user-editor', 'editor');

		await expect(t.mutation(api.mail.appPasswords.revokeAll, { mailboxId })).rejects.toThrow();

		// Nothing got revoked.
		await t.run(async (ctx) => {
			expect((await ctx.db.get(ids.a))!.revokedAt).toBeUndefined();
			expect((await ctx.db.get(ids.b))!.revokedAt).toBeUndefined();
		});
	});
});
