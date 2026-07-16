import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../_generated/api';
import schema from '../../schema';

const auth = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'editor' }));

vi.mock('../../lib/sessionOrganization', async () => ({
	...(await vi.importActual('../../lib/sessionOrganization')),
	getMutationContext: vi.fn(async (ctx: { auth: { getUserIdentity(): Promise<unknown> } }) => {
		if (!(await ctx.auth.getUserIdentity())) throw new Error('unauthenticated');
		return { userId: 'owner', role: auth.role };
	}),
	requireAdminContext: vi.fn(async (ctx: { auth: { getUserIdentity(): Promise<unknown> } }) => {
		if (!(await ctx.auth.getUserIdentity())) throw new Error('unauthenticated');
		if (auth.role === 'editor') throw new Error('forbidden');
		return { userId: 'owner', role: auth.role };
	}),
	getSingletonOrganizationId: vi.fn().mockResolvedValue('tenant'),
}));

vi.mock('../draftStrategyCatalog.generated', () => ({
	BUNDLED_PLUGIN_DRAFT_STRATEGY_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.draft-pack.legal',
			pluginId: 'draft-pack',
			label: 'Legal',
			timeoutMs: 1_000,
			requiredEnvVars: Object.freeze([]),
			requiredCapability: 'draft:strategy',
		}),
	]),
}));

const rootGlob = import.meta.glob('../../**/*.*s');
const pluginGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../plugins/'),
		module,
	])
);
const modules = { ...rootGlob, ...pluginGlob };
const identity = {
	subject: 'owner',
	issuer: 'https://test.issuer.example',
	tokenIdentifier: 'https://test.issuer.example|owner',
};

beforeEach(() => {
	auth.role = 'owner';
});

describe('draft strategy selection mutations', () => {
	it('requires authentication and an admin role', async () => {
		const anonymous = convexTest(schema, modules);
		await expect(
			anonymous.mutation(api.plugins.draftStrategySelections.setSelection, {
				scope: { type: 'classification', id: 'support' },
				strategyKind: 'plugin.draft-pack.legal',
			})
		).rejects.toThrow('unauthenticated');

		auth.role = 'editor';
		const member = convexTest(schema, modules).withIdentity(identity);
		await expect(
			member.mutation(api.plugins.draftStrategySelections.setSelection, {
				scope: { type: 'classification', id: 'support' },
				strategyKind: 'plugin.draft-pack.legal',
			})
		).rejects.toThrow('forbidden');
		await member.run(async (ctx) => {
			expect(await ctx.db.query('draftStrategySelections').collect()).toEqual([]);
		});
	});

	it('creates, updates idempotently, and removes a classification selection', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		const scope = { type: 'classification' as const, id: 'support' };

		await t.mutation(api.plugins.draftStrategySelections.setSelection, {
			scope,
			strategyKind: 'plugin.draft-pack.legal',
		});
		await t.mutation(api.plugins.draftStrategySelections.setSelection, {
			scope,
			strategyKind: 'plugin.draft-pack.legal',
		});
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('draftStrategySelections').collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				organizationId: 'tenant',
				scopeType: 'classification',
				scopeId: 'support',
				strategyKind: 'plugin.draft-pack.legal',
			});
		});

		await t.mutation(api.plugins.draftStrategySelections.setSelection, {
			scope,
			strategyKind: 'default',
		});
		await t.run(async (ctx) => {
			expect(await ctx.db.query('draftStrategySelections').collect()).toEqual([]);
		});
	});

	it('accepts live mailbox/contact scopes and rejects foreign or deleted rows', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		const ids = await t.run(async (ctx) => {
			const now = Date.now();
			const liveMailbox = await ctx.db.insert('mailboxes', {
				userId: 'owner',
				organizationId: 'tenant',
				address: 'live@example.test',
				domain: 'example.test',
				status: 'active',
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
			const foreignMailbox = await ctx.db.insert('mailboxes', {
				userId: 'other',
				organizationId: 'other-tenant',
				address: 'foreign@example.test',
				domain: 'example.test',
				status: 'active',
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
			const deletedMailbox = await ctx.db.insert('mailboxes', {
				userId: 'owner',
				organizationId: 'tenant',
				address: 'deleted@example.test',
				domain: 'example.test',
				status: 'deleted',
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
			const liveContact = await ctx.db.insert('contacts', {
				source: 'inbound',
				doiStatus: 'not_required',
				createdAt: now,
				updatedAt: now,
			});
			const deletedContact = await ctx.db.insert('contacts', {
				source: 'inbound',
				doiStatus: 'not_required',
				deletedAt: now,
				createdAt: now,
				updatedAt: now,
			});
			return { liveMailbox, foreignMailbox, deletedMailbox, liveContact, deletedContact };
		});

		for (const scope of [
			{ type: 'mailbox' as const, id: ids.liveMailbox },
			{ type: 'contact' as const, id: ids.liveContact },
		]) {
			await t.mutation(api.plugins.draftStrategySelections.setSelection, {
				scope,
				strategyKind: 'plugin.draft-pack.legal',
			});
		}
		for (const scope of [
			{ type: 'mailbox' as const, id: ids.foreignMailbox },
			{ type: 'mailbox' as const, id: ids.deletedMailbox },
			{ type: 'contact' as const, id: ids.deletedContact },
		]) {
			await expect(
				t.mutation(api.plugins.draftStrategySelections.setSelection, {
					scope,
					strategyKind: 'plugin.draft-pack.legal',
				})
			).rejects.toThrow('Unknown draft strategy scope');
		}
		await t.run(async (ctx) => {
			expect(await ctx.db.query('draftStrategySelections').collect()).toHaveLength(2);
		});
	});

	it('fails safely to default when storage contains duplicate scope rows', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const row = {
				organizationId: 'tenant',
				scopeType: 'classification' as const,
				scopeId: 'support',
				strategyKind: 'plugin.draft-pack.legal',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			await ctx.db.insert('draftStrategySelections', row);
			await ctx.db.insert('draftStrategySelections', row);
		});
		await expect(
			t.query(internal.plugins.draftStrategySelections.resolveForDraft, {
				classification: 'support',
			})
		).resolves.toBe('default');
	});

	it('rejects unknown strategies and noncanonical classifications without writing', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		await expect(
			t.mutation(api.plugins.draftStrategySelections.setSelection, {
				scope: { type: 'classification', id: 'support' },
				strategyKind: 'plugin.retired.missing',
			})
		).rejects.toThrow('Unknown draft strategy');
		await expect(
			t.mutation(api.plugins.draftStrategySelections.setSelection, {
				scope: { type: 'classification', id: 'invented-category' },
				strategyKind: 'plugin.draft-pack.legal',
			})
		).rejects.toThrow('Invalid draft classification scope');
		await t.run(async (ctx) => {
			expect(await ctx.db.query('draftStrategySelections').collect()).toEqual([]);
		});
	});
});
