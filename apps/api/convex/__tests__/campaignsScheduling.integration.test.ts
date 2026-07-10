/**
 * Integration tests for campaign scheduling, test-send, archive, and the
 * just-shipped audit rows on create/remove/reschedule.
 *
 *   - campaigns/scheduling.ts:
 *       schedule/cancel/reschedule/unschedule permission gate (campaigns:schedule),
 *       only `scheduled` campaigns may be cancelled/rescheduled/unscheduled,
 *       reschedule's future-date guard, and reschedule's `campaign.scheduled`
 *       audit row.
 *   - campaigns/testSend.ts: the recipient allowlist guard — a member can only
 *       test-send to the org's own member inboxes; a disallowed recipient is
 *       rejected (`forbidden`).
 *   - campaigns/archiveHttp.ts (driven through `t.fetch`): a valid archive token
 *       renders; a bogus token 404s; an archive-disabled / not-yet-sent campaign
 *       is unreachable.
 *   - campaigns/campaigns.ts: create/remove write `campaign.created` /
 *       `campaign.deleted` audit rows.
 *
 * The session mock is MUTABLE (chat.integration.test.ts pattern) so the
 * role-gate cases can flip owner ↔ editor. The rateLimiter component is
 * registered because the test-send guard and the public archive endpoint both
 * hit it.
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { createTestCampaign, enableFeatures } from './factories';

// Mutable session mock — flip role per test (owner/admin can schedule + manage;
// editor cannot).
const sessionMock = vi.hoisted(() => ({
	user: { id: 'test-user', role: 'owner' as 'owner' | 'admin' | 'editor' },
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../lib/sessionOrganization')>(
		'../lib/sessionOrganization'
	);
	const { realPermissionGate } = await import('./helpers/permissionGateMock');
	const gate = realPermissionGate(actual, () => sessionMock.user.role);
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockImplementation(async () => sessionMock.user.id),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		requireOrgPermission: vi
			.fn()
			.mockImplementation(async (_ctx: unknown, permission: string, message?: string) => {
				gate(permission, message);
				return { userId: sessionMock.user.id, role: sessionMock.user.role };
			}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
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
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const setUser = (id: string, role: 'owner' | 'admin' | 'editor' = 'owner') => {
	sessionMock.user.id = id;
	sessionMock.user.role = role;
};

function setupTest(): TestConvex<typeof schema> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
	setUser('test-user', 'owner');
});

// Seed a campaign in an arbitrary status directly (bypasses the wizard / send
// pre-flight, which require a verified domain + audience + template).
async function seedCampaign(
	t: TestConvex<typeof schema>,
	overrides: Record<string, unknown> = {}
): Promise<Id<'campaigns'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('campaigns', createTestCampaign(overrides) as never)
	);
}

// ============================================================================
// scheduling.reschedule
// ============================================================================

describe('campaigns.scheduling.reschedule', () => {
	it('reschedules a scheduled campaign to a future time and writes a campaign.scheduled audit row', async () => {
		const t = setupTest();
		const future = Date.now() + 24 * HOUR;
		const campaignId = await seedCampaign(t, {
			status: 'scheduled',
			scheduledAt: Date.now() + 2 * HOUR,
		});

		const newScheduledAt = Date.now() + 48 * HOUR;
		await t.mutation(api.campaigns.scheduling.reschedule, {
			campaignId,
			scheduledAt: newScheduledAt,
		});

		const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(campaign?.status).toBe('scheduled');
		expect(campaign?.scheduledAt).toBe(newScheduledAt);

		// The reschedule writes its own `campaign.scheduled` audit row (it patches
		// scheduledAt without a status transition, so the lifecycle audit wouldn't
		// otherwise fire).
		const audits = await t.run(async (ctx) =>
			ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('action'), 'campaign.scheduled'))
				.collect()
		);
		expect(audits.length).toBe(1);
		expect(audits[0]!.resourceId).toBe(campaignId);
		expect(audits[0]!.userId).toBe('test-user');
		// `future` only here to keep a stable reference for the future-date intent.
		expect(newScheduledAt).toBeGreaterThan(future - 24 * HOUR);
	});

	it('toggles recipient-timezone staggering and the target local hour on reschedule', async () => {
		const t = setupTest();
		// Seed a wall-clock (non-timezone) scheduled campaign.
		const campaignId = await seedCampaign(t, {
			status: 'scheduled',
			scheduledAt: Date.now() + 2 * HOUR,
			useRecipientTimezone: false,
		});

		const newScheduledAt = Date.now() + 48 * HOUR;
		await t.mutation(api.campaigns.scheduling.reschedule, {
			campaignId,
			scheduledAt: newScheduledAt,
			useRecipientTimezone: true,
			scheduledHour: 9,
			scheduledMinute: 30,
		});

		const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(campaign?.status).toBe('scheduled');
		expect(campaign?.scheduledAt).toBe(newScheduledAt);
		expect(campaign?.useRecipientTimezone).toBe(true);
		expect(campaign?.scheduledHour).toBe(9);
		expect(campaign?.scheduledMinute).toBe(30);
	});

	it('turns recipient-timezone staggering back off on reschedule', async () => {
		const t = setupTest();
		const campaignId = await seedCampaign(t, {
			status: 'scheduled',
			scheduledAt: Date.now() + 2 * HOUR,
			useRecipientTimezone: true,
			scheduledHour: 9,
			scheduledMinute: 0,
		});

		await t.mutation(api.campaigns.scheduling.reschedule, {
			campaignId,
			scheduledAt: Date.now() + 24 * HOUR,
			useRecipientTimezone: false,
		});

		const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(campaign?.useRecipientTimezone).toBe(false);
	});

	it('leaves timezone fields untouched when reschedule omits them', async () => {
		const t = setupTest();
		const campaignId = await seedCampaign(t, {
			status: 'scheduled',
			scheduledAt: Date.now() + 2 * HOUR,
			useRecipientTimezone: true,
			scheduledHour: 8,
			scheduledMinute: 15,
		});

		await t.mutation(api.campaigns.scheduling.reschedule, {
			campaignId,
			scheduledAt: Date.now() + 24 * HOUR,
		});

		const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(campaign?.useRecipientTimezone).toBe(true);
		expect(campaign?.scheduledHour).toBe(8);
		expect(campaign?.scheduledMinute).toBe(15);
	});

	it('rejects a reschedule into the past', async () => {
		const t = setupTest();
		const campaignId = await seedCampaign(t, {
			status: 'scheduled',
			scheduledAt: Date.now() + 2 * HOUR,
		});

		await expect(
			t.mutation(api.campaigns.scheduling.reschedule, {
				campaignId,
				scheduledAt: Date.now() - HOUR,
			})
		).rejects.toThrow();
	});

	it('rejects rescheduling a campaign that is not scheduled', async () => {
		const t = setupTest();
		const campaignId = await seedCampaign(t, { status: 'draft' });

		await expect(
			t.mutation(api.campaigns.scheduling.reschedule, {
				campaignId,
				scheduledAt: Date.now() + 24 * HOUR,
			})
		).rejects.toThrow();
	});

	it('accepts an editor (holds campaigns:schedule under the d4 map)', async () => {
		const t = setupTest();
		const campaignId = await seedCampaign(t, {
			status: 'scheduled',
			scheduledAt: Date.now() + 2 * HOUR,
		});

		setUser('editor-user', 'editor');
		const newAt = Date.now() + 24 * HOUR;
		await expect(
			t.mutation(api.campaigns.scheduling.reschedule, {
				campaignId,
				scheduledAt: newAt,
			})
		).resolves.toBe(campaignId);

		// The reschedule landed: scheduledAt moved and the audit row was written
		// under the editor's id — positively proving they cleared the role gate.
		const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(campaign?.scheduledAt).toBe(newAt);
		const audits = await t.run(async (ctx) =>
			ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('action'), 'campaign.scheduled'))
				.collect()
		);
		expect(audits.length).toBe(1);
		expect(audits[0]!.userId).toBe('editor-user');
	});
});

// ============================================================================
// scheduling.cancel
// ============================================================================

describe('campaigns.scheduling.cancel', () => {
	it('cancels a scheduled campaign', async () => {
		const t = setupTest();
		const campaignId = await seedCampaign(t, {
			status: 'scheduled',
			scheduledAt: Date.now() + 2 * HOUR,
		});

		await t.mutation(api.campaigns.scheduling.cancel, { campaignId });

		const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(campaign?.status).toBe('cancelled');
	});

	it('rejects cancelling a draft campaign (only scheduled can be cancelled)', async () => {
		const t = setupTest();
		const campaignId = await seedCampaign(t, { status: 'draft' });

		await expect(t.mutation(api.campaigns.scheduling.cancel, { campaignId })).rejects.toThrow();
	});

	it('accepts an editor (holds campaigns:schedule under the d4 map)', async () => {
		const t = setupTest();
		const campaignId = await seedCampaign(t, {
			status: 'scheduled',
			scheduledAt: Date.now() + 2 * HOUR,
		});

		setUser('editor-user', 'editor');
		await expect(t.mutation(api.campaigns.scheduling.cancel, { campaignId })).resolves.toBe(
			campaignId
		);

		const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(campaign?.status).toBe('cancelled');
	});

	it('404s on a missing campaign', async () => {
		const t = setupTest();
		const ghost = await seedCampaign(t, { status: 'scheduled', scheduledAt: Date.now() + HOUR });
		await t.run(async (ctx) => ctx.db.delete(ghost));

		await expect(
			t.mutation(api.campaigns.scheduling.cancel, { campaignId: ghost })
		).rejects.toThrow();
	});
});

// ============================================================================
// scheduling.unschedule
// ============================================================================

describe('campaigns.scheduling.unschedule', () => {
	it('returns a scheduled campaign to draft', async () => {
		const t = setupTest();
		const campaignId = await seedCampaign(t, {
			status: 'scheduled',
			scheduledAt: Date.now() + 2 * HOUR,
		});

		await t.mutation(api.campaigns.scheduling.unschedule, { campaignId });

		const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(campaign?.status).toBe('draft');
		expect(campaign?.scheduledAt).toBeUndefined();
	});

	it('rejects unscheduling a draft campaign', async () => {
		const t = setupTest();
		const campaignId = await seedCampaign(t, { status: 'draft' });

		await expect(t.mutation(api.campaigns.scheduling.unschedule, { campaignId })).rejects.toThrow();
	});

	it('accepts an editor (holds campaigns:schedule under the d4 map)', async () => {
		const t = setupTest();
		const campaignId = await seedCampaign(t, {
			status: 'scheduled',
			scheduledAt: Date.now() + 2 * HOUR,
		});

		setUser('editor-user', 'editor');
		await expect(t.mutation(api.campaigns.scheduling.unschedule, { campaignId })).resolves.toBe(
			campaignId
		);

		const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(campaign?.status).toBe('draft');
		expect(campaign?.scheduledAt).toBeUndefined();
	});
});

// ============================================================================
// scheduling.schedule — permission + status + future-date gates
// ============================================================================

describe('campaigns.scheduling.schedule', () => {
	it('does not reject an editor on the role gate — a bare draft fails downstream preflight', async () => {
		const t = setupTest();
		// Bare draft: no template/audience, so validateReadyToSend fails. Under the
		// d4 map the editor holds campaigns:schedule, so the rejection is the
		// preflight failure, NOT the role gate — proving the editor cleared it.
		const campaignId = await seedCampaign(t, { status: 'draft' });

		setUser('editor-user', 'editor');
		await expect(
			t.mutation(api.campaigns.scheduling.schedule, {
				campaignId,
				scheduledAt: Date.now() + 24 * HOUR,
			})
		).rejects.toThrow(/must have an email template/i);
	});

	it('rejects scheduling a non-draft campaign', async () => {
		const t = setupTest();
		const campaignId = await seedCampaign(t, {
			status: 'scheduled',
			scheduledAt: Date.now() + 2 * HOUR,
		});

		await expect(
			t.mutation(api.campaigns.scheduling.schedule, {
				campaignId,
				scheduledAt: Date.now() + 24 * HOUR,
			})
		).rejects.toThrow();
	});

	it('rejects a draft campaign that fails preflight (no template/audience/domain)', async () => {
		const t = setupTest();
		// A bare draft has no emailTemplateId/audience, so validateReadyToSend
		// fails the very first check — the schedule must be rejected even though
		// the role + status gates pass.
		const campaignId = await seedCampaign(t, {
			status: 'draft',
			emailTemplateId: undefined,
			audience: undefined,
		});

		await expect(
			t.mutation(api.campaigns.scheduling.schedule, {
				campaignId,
				scheduledAt: Date.now() + 24 * HOUR,
			})
		).rejects.toThrow();
	});
});

// ============================================================================
// testSend.sendTestEmailFromTemplate — recipient allowlist guard
// ============================================================================

describe('campaigns.testSend.sendTestEmailFromTemplate (recipient allowlist)', () => {
	it('rejects a well-formed recipient that is NOT an org member inbox', async () => {
		const t = setupTest();
		// Seed exactly one member inbox — the allowlist is the userProfiles roster.
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('userProfiles', {
				authUserId: 'test-user',
				email: 'member@owlat.test',
				name: 'Member',
				createdAt: now,
				updatedAt: now,
			});
		});

		// `attacker@evil.test` is a valid email but not a member inbox — the guard
		// must reject it so test-send can't relay HTML to arbitrary externals.
		await expect(
			t.action(api.campaigns.testSend.sendTestEmailFromTemplate, {
				htmlContent: '<p>hi</p>',
				subject: 'Preview',
				testEmails: ['attacker@evil.test'],
				fromEmail: 'sender@owlat.test',
			})
		).rejects.toThrow();
	});

	it('rejects an outright invalid email address before the allowlist check', async () => {
		const t = setupTest();
		await expect(
			t.action(api.campaigns.testSend.sendTestEmailFromTemplate, {
				htmlContent: '<p>hi</p>',
				subject: 'Preview',
				testEmails: ['not-an-email'],
				fromEmail: 'sender@owlat.test',
			})
		).rejects.toThrow();
	});

	it('rejects an empty recipient list', async () => {
		const t = setupTest();
		await expect(
			t.action(api.campaigns.testSend.sendTestEmailFromTemplate, {
				htmlContent: '<p>hi</p>',
				subject: 'Preview',
				testEmails: [],
				fromEmail: 'sender@owlat.test',
			})
		).rejects.toThrow();
	});
});

// ============================================================================
// archiveHttp — GET /archive/:token  (driven through t.fetch)
// ============================================================================

describe('GET /archive/:token (archiveHttp)', () => {
	const ARCHIVE_HTML = '<html><body><h1>Archived newsletter</h1></body></html>';

	async function seedArchivedCampaign(
		t: TestConvex<typeof schema>,
		overrides: Record<string, unknown> = {}
	): Promise<{ token: string }> {
		const token = `arch_${Math.random().toString(36).slice(2)}`;
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'sent',
					archiveEnabled: true,
					archiveToken: token,
					archiveHtmlContent: ARCHIVE_HTML,
					archiveSubject: 'Archived subject',
					sentAt: Date.now(),
					...overrides,
				}) as never
			);
		});
		return { token };
	}

	it('renders the snapshot for a valid archive token (200, ok:true)', async () => {
		const t = setupTest();
		const { token } = await seedArchivedCampaign(t);

		const res = await t.fetch(`/archive/${token}`, { method: 'GET' });
		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			ok: boolean;
			data: { html: string; subject: string };
		};
		expect(json.ok).toBe(true);
		expect(json.data.html).toBe(ARCHIVE_HTML);
		expect(json.data.subject).toBe('Archived subject');
	});

	it('404s on a bogus token', async () => {
		const t = setupTest();
		// No campaign seeded for this token.
		const res = await t.fetch('/archive/does-not-exist', { method: 'GET' });
		expect(res.status).toBe(404);
		const json = (await res.json()) as { error: { message: string } };
		expect(json.error).toBeDefined();
	});

	it('404s when the campaign is archive-enabled but not yet sent', async () => {
		const t = setupTest();
		// archiveQueries only returns rows with status === 'sent'.
		const { token } = await seedArchivedCampaign(t, { status: 'scheduled' });

		const res = await t.fetch(`/archive/${token}`, { method: 'GET' });
		expect(res.status).toBe(404);
	});

	it('404s when archive is disabled even though the campaign is sent', async () => {
		const t = setupTest();
		const { token } = await seedArchivedCampaign(t, { archiveEnabled: false });

		const res = await t.fetch(`/archive/${token}`, { method: 'GET' });
		expect(res.status).toBe(404);
	});
});

// ============================================================================
// campaigns.create / campaigns.remove — audit rows
// ============================================================================

describe('campaigns.create (campaign.created audit)', () => {
	it('writes a campaign.created audit row on create', async () => {
		const t = setupTest();
		await enableFeatures(t, ['campaigns']);

		const campaignId = await t.mutation(api.campaigns.campaigns.create, {
			name: 'Launch Day',
		});
		expect(campaignId).toBeDefined();

		const audits = await t.run(async (ctx) =>
			ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('action'), 'campaign.created'))
				.collect()
		);
		expect(audits.length).toBe(1);
		expect(audits[0]!.resourceId).toBe(campaignId);
		expect(audits[0]!.resource).toBe('campaign');
		expect(audits[0]!.userId).toBe('test-user');
	});

	it('accepts an editor (holds campaigns:manage under the d4 map) and writes the audit row', async () => {
		const t = setupTest();
		await enableFeatures(t, ['campaigns']);

		setUser('editor-user', 'editor');
		const campaignId = await t.mutation(api.campaigns.campaigns.create, { name: 'Editor Launch' });
		expect(campaignId).toBeDefined();

		const audits = await t.run(async (ctx) =>
			ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('action'), 'campaign.created'))
				.collect()
		);
		expect(audits.length).toBe(1);
		expect(audits[0]!.resourceId).toBe(campaignId);
		expect(audits[0]!.userId).toBe('editor-user');
	});
});

describe('campaigns.remove (campaign.deleted audit)', () => {
	it('deletes a draft campaign and writes a campaign.deleted audit row', async () => {
		const t = setupTest();
		const campaignId = await seedCampaign(t, { status: 'draft', name: 'Doomed' });

		await t.mutation(api.campaigns.campaigns.remove, { campaignId });

		const gone = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(gone).toBeNull();

		const audits = await t.run(async (ctx) =>
			ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('action'), 'campaign.deleted'))
				.collect()
		);
		expect(audits.length).toBe(1);
		expect(audits[0]!.resourceId).toBe(campaignId);
		expect(audits[0]!.userId).toBe('test-user');
	});

	it('refuses to delete a campaign that is currently sending', async () => {
		const t = setupTest();
		const campaignId = await seedCampaign(t, { status: 'sending' });

		await expect(t.mutation(api.campaigns.campaigns.remove, { campaignId })).rejects.toThrow();

		// Still present; no deletion audit row.
		const stillThere = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(stillThere).not.toBeNull();
	});

	it('accepts an editor (holds campaigns:manage under the d4 map)', async () => {
		const t = setupTest();
		const campaignId = await seedCampaign(t, { status: 'draft' });

		setUser('editor-user', 'editor');
		await t.mutation(api.campaigns.campaigns.remove, { campaignId });

		const gone = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(gone).toBeNull();
	});
});
