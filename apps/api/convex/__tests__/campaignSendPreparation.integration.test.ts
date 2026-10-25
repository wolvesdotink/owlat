/**
 * The campaign send orchestrator's PREPARATION step (`startCampaignSend`):
 * everything between the fire-time guards and the hand-off to the send walker.
 *
 * These cases pin what one preparation leaves behind, outcome by outcome —
 * the campaign status and its audit trail, the content-scan row, the template
 * version captured for the send, the archive snapshot, the frozen segment and
 * the send job plus the walker hop it schedules — so the step can be reshaped
 * without changing what it writes.
 *
 * Scheduled work is held on fake timers and read back from
 * `_scheduled_functions`; nothing downstream of the preparation runs here.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import schema from '../schema';
import type * as EmailScanner from '@owlat/email-scanner';
import {
	BLOCKED_VERDICT,
	SUSPICIOUS_VERDICT,
	prepared,
	seed,
	start,
} from './helpers/campaignPreparation';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

// The scanner verdict drives the outcome: >= 40 blocked, >= 15 suspicious,
// else clean. Default is clean.
vi.mock('@owlat/email-scanner', async (importOriginal) => {
	const original = await importOriginal<typeof EmailScanner>();
	return {
		...original,
		scanContent: vi.fn(() => ({ score: 0, pass: true, flags: [], level: 'clean' as const })),
	};
});

const { scanContent: mockedScanContent } = await import('@owlat/email-scanner');

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('posthog') &&
			!path.includes('delivery/worker.ts') &&
			!path.includes('campaigns/testSend') &&
			!path.includes('delivery/workpool')
	)
);

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe('startCampaignSend preparation — a clean verdict', () => {
	it('a sending campaign: captures the version, opens a plain job, schedules the walker', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);

		const result = await start(t, seeded.campaignId);

		expect(result).toEqual({ totalRecipients: 0, totalBatches: 0 });
		const state = await prepared(t, seeded);
		expect(state.campaign?.status).toBe('sending');
		expect(state.scanRows).toEqual([]);
		expect(state.versions.map((row) => row.trigger)).toEqual(['send']);
		expect(state.jobs).toHaveLength(1);
		expect(state.jobs[0]).toMatchObject({ phase: 'resolving', variantMode: 'plain', cursor: '' });
		expect(state.scheduled).toContain('campaigns/send:resolveCampaignPage');
		expect(state.audits).toEqual([]);
	});

	it('a scheduled campaign: moves to sending on the scheduler tick and opens the job', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { status: 'scheduled' });

		const result = await start(t, seeded.campaignId);

		expect(result.skipped ?? false).toBe(false);
		const state = await prepared(t, seeded);
		expect(state.campaign?.status).toBe('sending');
		expect(state.campaign?.sentAt).toBeTypeOf('number');
		expect(state.campaign?.scheduledAt).toBeUndefined();
		expect(state.audits).toEqual([
			{ action: 'campaign.send_started', userId: 'system:scheduler_tick' },
		]);
		expect(state.versions.map((row) => row.trigger)).toEqual(['send']);
		expect(state.jobs).toHaveLength(1);
		expect(state.jobs[0]?.phase).toBe('resolving');
		expect(state.scheduled).toContain('campaigns/send:resolveCampaignPage');
	});

	it('freezes a segment audience on the campaign', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { segment: true });

		await start(t, seeded.campaignId);

		const state = await prepared(t, seeded);
		const audience = state.campaign?.audience;
		expect(audience?.kind).toBe('segment');
		expect(audience?.kind === 'segment' ? audience.frozenFilters : undefined).toBeDefined();
		expect(state.jobs[0]?.audience).toEqual(audience);
	});

	it('writes the public archive snapshot when the campaign archives and SITE_URL is set', async () => {
		vi.stubEnv('SITE_URL', 'https://owlat.example');
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { archiveEnabled: true });

		await start(t, seeded.campaignId);

		const state = await prepared(t, seeded);
		expect(state.campaign?.archiveToken).toMatch(/^[\w-]{24}$/);
		expect(state.campaign?.archiveSubject).toBe('Hello {{firstName}}');
		expect(state.campaign?.archiveHtmlContent).toContain('Body for');
	});

	it('writes no archive snapshot when the campaign does not archive', async () => {
		vi.stubEnv('SITE_URL', 'https://owlat.example');
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { archiveEnabled: false });

		await start(t, seeded.campaignId);

		const state = await prepared(t, seeded);
		expect(state.campaign?.archiveToken).toBeUndefined();
	});

	it('an A/B campaign already testing opens an ab_test job', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { isABTest: true });

		await start(t, seeded.campaignId);

		const state = await prepared(t, seeded);
		expect(state.jobs[0]).toMatchObject({ variantMode: 'ab_test', splitPercentage: 20 });
	});
});

describe('startCampaignSend preparation — a non-clean verdict', () => {
	it('blocked, from sending: draft with the reason, a scan row, and nothing prepared', async () => {
		(mockedScanContent as Mock).mockReturnValueOnce(BLOCKED_VERDICT);
		const t = convexTest(schema, modules);
		const seeded = await seed(t);

		const result = await start(t, seeded.campaignId);

		expect(result).toMatchObject({ skipped: true, reason: expect.stringMatching(/blocked/i) });
		const state = await prepared(t, seeded);
		expect(state.campaign?.status).toBe('draft');
		expect(state.campaign?.contentBlockReason).toBe('Content blocked: Prohibited content');
		expect(state.scanRows.map((row) => [row.level, row.score])).toEqual([['blocked', 80]]);
		expect(state.audits).toEqual([
			{ action: 'campaign.content_blocked', userId: 'system:content_scan' },
		]);
		expect(state.versions).toEqual([]);
		expect(state.jobs).toEqual([]);
		expect(state.scheduled).not.toContain('campaigns/send:resolveCampaignPage');
	});

	it('blocked, from scheduled: the send starts and is reverted in the same audit trail', async () => {
		(mockedScanContent as Mock).mockReturnValueOnce(BLOCKED_VERDICT);
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { status: 'scheduled' });

		await start(t, seeded.campaignId);

		const state = await prepared(t, seeded);
		expect(state.campaign?.status).toBe('draft');
		expect(state.audits).toEqual([
			{ action: 'campaign.send_started', userId: 'system:scheduler_tick' },
			{ action: 'campaign.content_blocked', userId: 'system:content_scan' },
		]);
		expect(state.versions).toEqual([]);
		expect(state.jobs).toEqual([]);
		expect(state.scheduled).not.toContain('campaigns/send:resolveCampaignPage');
	});

	it('suspicious, from scheduled: held for review with a scan row and nothing prepared', async () => {
		(mockedScanContent as Mock).mockReturnValueOnce(SUSPICIOUS_VERDICT);
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { status: 'scheduled' });

		const result = await start(t, seeded.campaignId);

		expect(result).toMatchObject({ skipped: true, reason: expect.stringMatching(/review/i) });
		const state = await prepared(t, seeded);
		expect(state.campaign?.status).toBe('pending_review');
		expect(state.scanRows.map((row) => row.level)).toEqual(['suspicious']);
		expect(state.audits).toEqual([
			{ action: 'campaign.send_started', userId: 'system:scheduler_tick' },
			{ action: 'campaign.flagged_for_review', userId: 'system:content_scan' },
		]);
		expect(state.versions).toEqual([]);
		expect(state.jobs).toEqual([]);
	});
});

describe('startCampaignSend preparation — fire-time guards write nothing', () => {
	it.each([
		['cancelled', /cancelled/i],
		['draft', /unscheduled/i],
		['sent', /already sent/i],
	] as const)('a %s campaign is skipped', async (status, reason) => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(seeded.campaignId, { status });
		});

		const result = await start(t, seeded.campaignId);

		expect(result).toMatchObject({ skipped: true, reason: expect.stringMatching(reason) });
		const state = await prepared(t, seeded);
		expect(state.campaign?.status).toBe(status);
		expect(state.versions).toEqual([]);
		expect(state.jobs).toEqual([]);
		expect(state.audits).toEqual([]);
	});
});
