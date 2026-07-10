import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { isCampaignSenderAllowed, seedDefaultSenderIfNeeded } from '../senders';
import type { Id } from '../../_generated/dataModel';
import {
	createTestCampaign,
	createTestCampaignSender,
	createTestDomain,
	createTestEmailTemplate,
	createTestInstanceSettings,
	createTestTopic,
} from '../../__tests__/factories';

/**
 * Curated campaign-sender enforcement (2026-07-10 experience plan, decision 8).
 *
 * Three layers are exercised here:
 *   1. `isCampaignSenderAllowed` — the list/toggle gate both send sites delegate to.
 *   2. The CRUD write path — verified-domain guard + `seedDefaultSenderIfNeeded`.
 *   3. The ENFORCEMENT SITES themselves — the campaign pre-flight
 *      (`validateReadyToSend`) and the `sendTestEmail` action — so that dropping
 *      either gate call, not just breaking the helper, fails a test.
 */

// Mock the session floor so the authed wrappers (`authedQuery`/`authedMutation`
// membership floor, `authedAction`'s `assertOrgMember`, and the CRUD
// `campaigns:manage` check) run as an owner. Domain verification stays REAL
// (reads seeded `domains` rows).
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const admin = { userId: 'admin-a', role: 'owner' as const };
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue(admin),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('admin-a'),
		getMutationContext: vi.fn().mockResolvedValue(admin),
		requireOrgPermission: vi.fn().mockResolvedValue(admin),
	};
});

// Vite's `import.meta.glob` excludes the directory chain it climbed up through
// to reach the glob base, so `'../../**'` from this `campaigns/__tests__` file
// omits the sibling `campaigns/*` modules (including `campaigns/senders.ts`, the
// module under test). Merge a second glob rooted at `campaigns/` and re-prefix
// its keys to the same `../../`-relative form so convex-test resolves every entry.
const campaignsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../campaigns/'),
		mod,
	])
);
const allModules = { ...import.meta.glob('../../**/*.*s'), ...campaignsGlob };
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

// The pre-flight refuses to send when no delivery provider is configured, so
// the sender gate (which runs after that check) is only reached with one set.
beforeEach(() => {
	process.env['EMAIL_PROVIDER'] = 'mta';
	process.env['MTA_API_URL'] = 'http://mta:3100';
	process.env['MTA_API_KEY'] = 'test-key';
});
afterEach(() => {
	delete process.env['EMAIL_PROVIDER'];
	delete process.env['MTA_API_URL'];
	delete process.env['MTA_API_KEY'];
});

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
			await ctx.db.insert(
				'campaignSenders',
				createTestCampaignSender({ email: 'news@acme.com', isEnabled: true, isDefault: true })
			);
		});
		const allowed = await t.run((ctx) => isCampaignSenderAllowed(ctx, 'NEWS@ACME.com'));
		expect(allowed).toBe(true);
	});

	it('rejects a DISABLED curated sender when custom senders are off', async () => {
		const t = convexTest(schema, modules);
		await seedInstance(t, { allowCustom: false });
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaignSenders',
				createTestCampaignSender({ email: 'news@acme.com', isEnabled: false, isDefault: false })
			);
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

describe('seedDefaultSenderIfNeeded — idempotent bootstrap seed', () => {
	it('seeds one default sender from the org default, and is a no-op on repeat', async () => {
		const t = convexTest(schema, modules);
		await seedInstance(t, { defaultFromEmail: 'news@acme.com' });

		const first = await t.run((ctx) => seedDefaultSenderIfNeeded(ctx));
		expect(first).toBe(true);
		const second = await t.run((ctx) => seedDefaultSenderIfNeeded(ctx));
		expect(second).toBe(false);

		const rows = await t.query(api.campaigns.senders.list, {});
		expect(rows).toHaveLength(1);
		expect(rows[0]?.email).toBe('news@acme.com');
		expect(rows[0]?.isDefault).toBe(true);
		expect(rows[0]?.isEnabled).toBe(true);
	});

	it('does not seed when the org default sits on an unverified domain', async () => {
		const t = convexTest(schema, modules);
		await seedInstance(t, { defaultFromEmail: 'news@unverified.com' });
		const seeded = await t.run((ctx) => seedDefaultSenderIfNeeded(ctx));
		expect(seeded).toBe(false);
		const rows = await t.query(api.campaigns.senders.list, {});
		expect(rows).toHaveLength(0);
	});
});

/**
 * Enforcement-site coverage. `validateReadyToSend` and `sendTestEmail` are the
 * two places the curated-sender rule is applied server-side; these assert the
 * gate at the site, so dropping a call — not only breaking the helper — fails.
 */
async function seedReadyCampaign(
	t: ReturnType<typeof convexTest>,
	opts: { fromEmail: string; verified: boolean; allowCustom?: boolean }
): Promise<Id<'campaigns'>> {
	let campaignId: Id<'campaigns'>;
	await t.run(async (ctx) => {
		await ctx.db.insert(
			'domains',
			createTestDomain({
				domain: 'acme.com',
				status: opts.verified ? 'verified' : 'pending',
				lastVerifiedAt: opts.verified ? Date.now() : undefined,
			})
		);
		await ctx.db.insert(
			'instanceSettings',
			createTestInstanceSettings({ isCustomCampaignSendersAllowed: opts.allowCustom ?? false })
		);
		const templateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
		const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
		campaignId = await ctx.db.insert(
			'campaigns',
			createTestCampaign({
				status: 'draft',
				emailTemplateId: templateId,
				fromEmail: opts.fromEmail,
				audience: { kind: 'topic', topicId },
			})
		);
	});
	return campaignId!;
}

describe('validateReadyToSend — curated-sender enforcement site', () => {
	it('sender_not_allowed — off-list sender with the toggle off', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedReadyCampaign(t, { fromEmail: 'news@acme.com', verified: true });
		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('sender_not_allowed');
	});

	it('ok — an enabled curated sender passes', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedReadyCampaign(t, { fromEmail: 'news@acme.com', verified: true });
		await t.run(async (ctx) => {
			await ctx.db.insert('campaignSenders', createTestCampaignSender({ email: 'news@acme.com' }));
		});
		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});
		expect(result.ok).toBe(true);
	});

	it('ok — a custom sender on a verified domain passes when the toggle is on', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedReadyCampaign(t, {
			fromEmail: 'anyone@acme.com',
			verified: true,
			allowCustom: true,
		});
		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});
		expect(result.ok).toBe(true);
	});

	it('domain_not_verified still wins for a custom sender on an UNVERIFIED domain (toggle on)', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedReadyCampaign(t, {
			fromEmail: 'anyone@acme.com',
			verified: false,
			allowCustom: true,
		});
		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('domain_not_verified');
	});
});

describe('sendTestEmail — curated-sender enforcement site', () => {
	it('rejects a test send from an off-list sender with the toggle off', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedReadyCampaign(t, { fromEmail: 'news@acme.com', verified: true });
		await expect(
			t.action(api.campaigns.testSend.sendTestEmail, {
				campaignId,
				testEmail: 'admin@acme.com',
			})
		).rejects.toThrow(/not an approved campaign sender/i);
	});
});

/**
 * updateBasics is the wizard's write path (piece d3). It must refuse an off-list
 * from-address so the API cannot persist what the picker never offers — the
 * "no way to submit an off-list address from the UI or the API" guarantee.
 */
describe('updateBasics — wizard curated-sender enforcement site', () => {
	async function seedDraftCampaign(
		t: ReturnType<typeof convexTest>,
		opts: { allowCustom?: boolean; defaultFromEmail?: string } = {}
	): Promise<Id<'campaigns'>> {
		await seedInstance(t, opts);
		return t.run((ctx) => ctx.db.insert('campaigns', createTestCampaign({ status: 'draft' })));
	}

	it('rejects an off-list from-address when custom senders are off', async () => {
		const t = convexTest(schema, modules);
		// The seed self-heals news@acme.com (the verified org default); submitting a
		// DIFFERENT, non-curated address must still be refused.
		const campaignId = await seedDraftCampaign(t, { defaultFromEmail: 'news@acme.com' });
		await expect(
			t.mutation(api.campaigns.campaigns.updateBasics, {
				campaignId,
				fromName: 'Support',
				fromEmail: 'support@acme.com',
			})
		).rejects.toThrow(/not an approved campaign sender/i);
	});

	it('accepts the org default address via the self-healed seed with the toggle off', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedDraftCampaign(t, { defaultFromEmail: 'news@acme.com' });
		const result = await t.mutation(api.campaigns.campaigns.updateBasics, {
			campaignId,
			fromName: 'Acme News',
			fromEmail: 'news@acme.com',
		});
		expect(result).toBe(campaignId);
	});

	it('accepts an enabled curated sender with the toggle off', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedDraftCampaign(t, { defaultFromEmail: 'news@acme.com' });
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaignSenders',
				createTestCampaignSender({ email: 'support@acme.com', isEnabled: true })
			);
		});
		const result = await t.mutation(api.campaigns.campaigns.updateBasics, {
			campaignId,
			fromName: 'Support',
			fromEmail: 'support@acme.com',
		});
		expect(result).toBe(campaignId);
	});

	it('accepts an off-list address when custom senders are on', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedDraftCampaign(t, {
			allowCustom: true,
			defaultFromEmail: 'news@acme.com',
		});
		const result = await t.mutation(api.campaigns.campaigns.updateBasics, {
			campaignId,
			fromName: 'Anyone',
			fromEmail: 'anyone@acme.com',
		});
		expect(result).toBe(campaignId);
	});
});
