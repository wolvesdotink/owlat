import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { isCampaignSenderAllowed } from '../senders';
import { createTestDomain, createTestInstanceSettings } from '../../__tests__/factories';

/**
 * Curated campaign-sender enforcement (2026-07-10 experience plan, decision 8).
 *
 * The list/toggle gate `isCampaignSenderAllowed` is the single source of truth
 * that both the campaign preflight (`campaigns/preflight.ts`) and the test-send
 * actions (`campaigns/testSend.ts`) delegate to; testing it directly exercises
 * the gate both call sites enforce. The verified-domain hard gate is a separate
 * floor those call sites keep unchanged, so it is not re-asserted here.
 */

// Mock only the auth FLOOR (the `authedMutation`/`adminQuery` wrappers'
// `getMutationContext` / `requireOrgPermission`) so `api.campaigns.senders.*`
// run as an owner. Domain verification stays REAL (reads seeded `domains` rows).
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const admin = { userId: 'admin-a', role: 'owner' as const };
	return {
		...actual,
		getMutationContext: vi.fn().mockResolvedValue(admin),
		requireOrgPermission: vi.fn().mockResolvedValue(admin),
	};
});

const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

/** Seed a verified sending domain + an instanceSettings row. */
async function seedInstance(
	t: ReturnType<typeof convexTest>,
	opts: { allowCustom?: boolean; defaultFromEmail?: string } = {}
) {
	await t.run(async (ctx) => {
		await ctx.db.insert(
			'domains',
			createTestDomain({ domain: 'acme.com', status: 'verified', lastVerifiedAt: Date.now() })
		);
		await ctx.db.insert(
			'instanceSettings',
			createTestInstanceSettings({
				isCustomCampaignSendersAllowed: opts.allowCustom ?? false,
				defaultFromName: 'Acme News',
				defaultFromEmail: opts.defaultFromEmail ?? 'news@acme.com',
			})
		);
	});
}

describe('isCampaignSenderAllowed — list/toggle gate', () => {
	it('rejects an off-list address when custom senders are off', async () => {
		const t = convexTest(schema, modules);
		await seedInstance(t, { allowCustom: false });
		const allowed = await t.run((ctx) => isCampaignSenderAllowed(ctx, 'news@acme.com'));
		expect(allowed).toBe(false);
	});

	it('accepts an ENABLED curated sender even with custom senders off', async () => {
		const t = convexTest(schema, modules);
		await seedInstance(t, { allowCustom: false });
		await t.run(async (ctx) => {
			await ctx.db.insert('campaignSenders', {
				email: 'news@acme.com',
				isEnabled: true,
				isDefault: true,
				createdBy: 'admin-a',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		const allowed = await t.run((ctx) => isCampaignSenderAllowed(ctx, 'NEWS@ACME.com'));
		expect(allowed).toBe(true);
	});

	it('rejects a DISABLED curated sender when custom senders are off', async () => {
		const t = convexTest(schema, modules);
		await seedInstance(t, { allowCustom: false });
		await t.run(async (ctx) => {
			await ctx.db.insert('campaignSenders', {
				email: 'news@acme.com',
				isEnabled: false,
				isDefault: false,
				createdBy: 'admin-a',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		const allowed = await t.run((ctx) => isCampaignSenderAllowed(ctx, 'news@acme.com'));
		expect(allowed).toBe(false);
	});

	it('accepts an off-list address when custom senders are on', async () => {
		const t = convexTest(schema, modules);
		await seedInstance(t, { allowCustom: true });
		const allowed = await t.run((ctx) => isCampaignSenderAllowed(ctx, 'anyone@acme.com'));
		expect(allowed).toBe(true);
	});
});

describe('campaigns.senders CRUD — verified-domain guard', () => {
	it('rejects adding a sender on an unverified domain', async () => {
		const t = convexTest(schema, modules);
		await seedInstance(t);
		await expect(
			t.mutation(api.campaigns.senders.create, { email: 'hi@unverified.com' })
		).rejects.toThrow(/not verified|not registered/i);
	});

	it('adds a sender on a verified domain and lists it', async () => {
		const t = convexTest(schema, modules);
		await seedInstance(t);
		const id = await t.mutation(api.campaigns.senders.create, {
			email: 'News@Acme.com',
			displayName: 'Acme News',
		});
		expect(id).toBeDefined();
		const rows = await t.query(api.campaigns.senders.list, {});
		expect(rows).toHaveLength(1);
		expect(rows[0]?.email).toBe('news@acme.com'); // normalized
		expect(rows[0]?.isDefault).toBe(true); // first sender becomes default
		expect(rows[0]?.isEnabled).toBe(true);
	});

	it('rejects a duplicate address', async () => {
		const t = convexTest(schema, modules);
		await seedInstance(t);
		await t.mutation(api.campaigns.senders.create, { email: 'news@acme.com' });
		await expect(
			t.mutation(api.campaigns.senders.create, { email: 'NEWS@acme.com' })
		).rejects.toThrow(/already/i);
	});
});

describe('campaigns.senders.ensureDefaultSeeded — idempotent seeding', () => {
	it('seeds one default sender from the org default, and is a no-op on repeat', async () => {
		const t = convexTest(schema, modules);
		await seedInstance(t, { defaultFromEmail: 'news@acme.com' });

		const first = await t.mutation(api.campaigns.senders.ensureDefaultSeeded, {});
		expect(first.seeded).toBe(true);
		const second = await t.mutation(api.campaigns.senders.ensureDefaultSeeded, {});
		expect(second.seeded).toBe(false);

		const rows = await t.query(api.campaigns.senders.list, {});
		expect(rows).toHaveLength(1);
		expect(rows[0]?.email).toBe('news@acme.com');
		expect(rows[0]?.isDefault).toBe(true);
	});

	it('does not seed when the org default sits on an unverified domain', async () => {
		const t = convexTest(schema, modules);
		await seedInstance(t, { defaultFromEmail: 'news@unverified.com' });
		const result = await t.mutation(api.campaigns.senders.ensureDefaultSeeded, {});
		expect(result.seeded).toBe(false);
		const rows = await t.query(api.campaigns.senders.list, {});
		expect(rows).toHaveLength(0);
	});
});
