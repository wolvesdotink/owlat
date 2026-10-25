/**
 * One walker hop's pure decisions (`campaigns/pageDecision.ts`) for fixed
 * jobs, campaigns and a fixed `now`. `campaignSendOrchestrator.integration.test.ts`
 * holds the live action (`send.ts:resolveCampaignPage`) to them.
 */
import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '../../_generated/dataModel';
import { utcDayKey } from '../../lib/clock';
import {
	bucketContent,
	bucketTemplateId,
	decideHopPlan,
	decideHopStart,
	decidePageEnd,
	hopSendContext,
	hopSendSettings,
	needsSendTimePlanning,
	planSendTimes,
	shouldCountAudience,
	type WalkingCampaign,
} from '../pageDecision';

const DAY = 86_400_000;
const DAY_START = Date.UTC(2026, 9, 25);
const NOW = DAY_START + DAY / 2;
const CAMPAIGN_ID = 'campaign_1' as Id<'campaigns'>;
const TEMPLATE_A = 'template_a' as Id<'emailTemplates'>;
const TEMPLATE_B = 'template_b' as Id<'emailTemplates'>;
const TOPIC_ID = 'topic_1' as Id<'topics'>;

const job = (overrides: Partial<Doc<'campaignSendJobs'>> = {}): Doc<'campaignSendJobs'> =>
	({
		_id: 'job_1',
		_creationTime: 0,
		campaignId: CAMPAIGN_ID,
		phase: 'resolving',
		cursor: '',
		audience: { kind: 'topic', topicId: TOPIC_ID },
		enqueuedCount: 0,
		totalCandidates: 0,
		...overrides,
	}) as Doc<'campaignSendJobs'>;

const campaign = (overrides: Partial<Doc<'campaigns'>> = {}): WalkingCampaign =>
	({
		_id: CAMPAIGN_ID,
		_creationTime: 0,
		name: 'Launch',
		status: 'sending',
		emailTemplateId: TEMPLATE_A,
		fromEmail: 'news@owlat.example',
		fromName: 'Owlat News',
		...overrides,
	}) as WalkingCampaign;

const NO_BUDGET = { capacityByDay: [], plannedTotal: null, isPlannedTotalCounted: false };

/** The page decision of an unbudgeted hop. */
function pageHop() {
	const hop = decideHopPlan({ job: job(), capacity: NO_BUDGET, fullPageSize: 500, now: NOW });
	if (hop.kind !== 'page') throw new Error('expected a page');
	return hop;
}

describe('decideHopStart', () => {
	it('stops a missing or finished walk and a campaign that left sending', () => {
		expect(decideHopStart(null, campaign())).toEqual({ kind: 'stop' });
		expect(decideHopStart(job({ phase: 'done' }), campaign())).toEqual({ kind: 'stop' });
		expect(decideHopStart(job(), null)).toEqual({ kind: 'stop' });
		expect(decideHopStart(job(), campaign({ status: 'draft' }))).toEqual({ kind: 'stop' });
	});

	it('never enqueues without a template or a From', () => {
		expect(decideHopStart(job(), campaign({ emailTemplateId: undefined }))).toEqual({
			kind: 'stop',
		});
		expect(decideHopStart(job(), campaign({ fromEmail: undefined }))).toEqual({ kind: 'stop' });
	});

	it('walks a resolving job of a sending campaign', () => {
		const walking = decideHopStart(job(), campaign());
		expect(walking.kind).toBe('walk');
	});

	it('counts the audience once per walk', () => {
		expect(shouldCountAudience(job())).toBe(true);
		expect(shouldCountAudience(job({ plannedTotal: 10 }))).toBe(false);
		expect(shouldCountAudience(job({ isPlannedTotalCountAttempted: true }))).toBe(false);
	});
});

describe('decideHopPlan', () => {
	it('reads a full page when no capacity is measured', () => {
		const hop = decideHopPlan({ job: job(), capacity: NO_BUDGET, fullPageSize: 500, now: NOW });
		expect(hop).toMatchObject({ kind: 'page', pageSize: undefined });
	});

	it("narrows the page to what is left of today's slice", () => {
		const hop = decideHopPlan({
			job: job({ planDayKey: utcDayKey(NOW), enqueuedToday: 4_900, planDayIndex: 0 }),
			capacity: { capacityByDay: [5_000, 5_000], plannedTotal: 8_000, isPlannedTotalCounted: true },
			fullPageSize: 500,
			now: NOW,
		});
		expect(hop).toMatchObject({
			kind: 'page',
			pageSize: 100,
			planCheckpoint: { plannedTotal: 8_000, isPlannedTotalCountAttempted: true },
		});
	});

	it('parks a spent day until the next cap window, with the day it carried', () => {
		const hop = decideHopPlan({
			job: job({
				planDayKey: utcDayKey(NOW),
				enqueuedToday: 5_000,
				planDayIndex: 0,
				enqueuedCount: 5_000,
			}),
			capacity: {
				capacityByDay: [5_000, 5_000],
				plannedTotal: 8_000,
				isPlannedTotalCounted: false,
			},
			fullPageSize: 500,
			now: NOW,
		});
		expect(hop).toMatchObject({
			kind: 'park',
			resumeAt: DAY_START + DAY,
			planDay: { planDayKey: utcDayKey(NOW), planDayIndex: 0, enqueuedToday: 5_000 },
		});
	});

	it('is the same plan on every evaluation and leaves its input alone', () => {
		const input = {
			job: job({ planDayKey: utcDayKey(NOW), enqueuedToday: 4_900, planDayIndex: 0 }),
			capacity: { capacityByDay: [5_000, 5_000], plannedTotal: 8_000, isPlannedTotalCounted: true },
			fullPageSize: 500,
			now: NOW,
		};
		const snapshot = structuredClone(input);
		expect(decideHopPlan(input)).toEqual(decideHopPlan(input));
		expect(input).toEqual(snapshot);
	});
});

describe('the send context', () => {
	it('derives the From, the archive link, the tracking base and the topic List-Id', () => {
		const walking = campaign({ archiveToken: 'tok', replyTo: 'reply@owlat.example' });
		const settings = hopSendSettings(job(), walking);
		expect(settings).toEqual({
			variantMode: 'plain',
			from: 'Owlat News <news@owlat.example>',
			isTimezoneAware: false,
			topicId: TOPIC_ID,
		});
		const context = hopSendContext({
			job: job(),
			campaign: walking,
			settings,
			route: { providerType: 'mta', ipPool: 'warm' },
			siteUrl: 'https://app.owlat.example',
			convexSiteUrl: 'https://api.owlat.example',
			trackingDomain: 'links.owlat.example',
			organizationId: 'org_1',
			topic: { _id: TOPIC_ID, name: 'Product news' },
			defaultTimezone: undefined,
		});
		expect(context).toMatchObject({
			from: 'Owlat News <news@owlat.example>',
			replyTo: 'reply@owlat.example',
			audienceType: 'topic',
			viewInBrowserUrl: 'https://app.owlat.example/archive?token=tok',
			providerType: 'mta',
			ipPool: 'warm',
			trackingBaseUrl: 'https://links.owlat.example',
			organizationId: 'org_1',
			useTimezone: false,
		});
		expect(context.listId).toMatch(/owlat\.example/);
	});

	it('gives a segment campaign no List-Id and a link-less archive without SITE_URL', () => {
		const segmentJob = job({ audience: { kind: 'segment', segmentId: 'seg' } } as Partial<
			Doc<'campaignSendJobs'>
		>);
		const walking = campaign({ fromName: undefined, archiveToken: 'tok' });
		const settings = hopSendSettings(segmentJob, walking);
		expect(settings.from).toBe('news@owlat.example');
		expect(settings.topicId).toBeUndefined();
		const context = hopSendContext({
			job: segmentJob,
			campaign: walking,
			settings,
			route: { providerType: 'mta' },
			siteUrl: undefined,
			convexSiteUrl: undefined,
			trackingDomain: undefined,
			organizationId: undefined,
			topic: null,
			defaultTimezone: undefined,
		});
		expect(context.listId).toBeUndefined();
		expect(context.viewInBrowserUrl).toBeUndefined();
		expect(context.trackingBaseUrl).toBeUndefined();
	});

	it('ignores the recipient timezone on the winner phase', () => {
		const tz = campaign({ useRecipientTimezone: true, scheduledHour: 9, scheduledMinute: 0 });
		expect(hopSendSettings(job(), tz).isTimezoneAware).toBe(true);
		expect(hopSendSettings(job({ variantMode: 'ab_winner' }), tz).isTimezoneAware).toBe(false);
	});

	it('plans send times only for an optimized plain campaign with recipients', () => {
		const optimized = campaign({
			sentAt: NOW,
			sendTimeOptimization: { windowHours: 4, holdoutPercent: 0 },
		});
		const recipients = [
			{ _id: 'contact_1' as Id<'contacts'>, email: 'a@example.com' },
			{ _id: 'contact_2' as Id<'contacts'>, email: 'b@example.com' },
		];
		expect(needsSendTimePlanning(campaign(), 'plain', 2)).toBe(false);
		expect(needsSendTimePlanning(optimized, 'ab_test', 2)).toBe(false);
		expect(needsSendTimePlanning(optimized, 'plain', 0)).toBe(false);
		expect(needsSendTimePlanning(optimized, 'plain', 2)).toBe(true);

		const input = {
			campaignId: CAMPAIGN_ID,
			campaign: optimized,
			variantMode: 'plain' as const,
			slice: pageHop().slice,
			recipients,
			planning: { organization: null, defaultTimezone: 'UTC' },
			now: NOW,
		};
		const planned = planSendTimes(input);
		expect([...(planned?.keys() ?? [])]).toEqual(['contact_1', 'contact_2']);
		for (const time of planned?.values() ?? []) {
			expect(time.at).toBeGreaterThanOrEqual(NOW);
			expect(time.at).toBeLessThan(NOW + 4 * 3_600_000);
		}
		expect(planSendTimes(input)).toEqual(planned);
		expect(planSendTimes({ ...input, campaign: campaign() })).toBeUndefined();
	});
});

describe('bucket content', () => {
	const content = { subject: 'Template subject', htmlContent: '<p>A</p>', plainTextContent: 'A' };

	it('uses the campaign subject over the template subject on a plain bucket', () => {
		expect(bucketTemplateId(undefined, campaign())).toBe(TEMPLATE_A);
		expect(bucketContent(undefined, campaign({ subject: 'Campaign subject' }), content)).toEqual({
			...content,
			subject: 'Campaign subject',
		});
		expect(bucketContent(undefined, campaign({ subject: undefined }), content)?.subject).toBe(
			'Template subject'
		);
	});

	it("sends a content test's variant B from its own template and subject", () => {
		const contentTest = campaign({
			subject: 'Campaign subject',
			abTestConfig: {
				testType: 'content',
				splitPercentage: 20,
				variantBTemplateId: TEMPLATE_B,
				winnerCriteria: 'manual',
			},
		} as Partial<Doc<'campaigns'>>);
		expect(bucketTemplateId('B', contentTest)).toBe(TEMPLATE_B);
		expect(bucketTemplateId('A', contentTest)).toBe(TEMPLATE_A);
		expect(bucketContent('B', contentTest, content)?.subject).toBe('Template subject');
		expect(bucketContent('A', contentTest, content)?.subject).toBe('Campaign subject');
	});

	it("sends a subject test's variant B with A's body and the alternate subject", () => {
		const subjectTest = campaign({
			subject: 'Campaign subject',
			abTestConfig: {
				testType: 'subject',
				splitPercentage: 20,
				variantBSubject: 'Alternate subject',
				winnerCriteria: 'manual',
			},
		} as Partial<Doc<'campaigns'>>);
		expect(bucketTemplateId('B', subjectTest)).toBe(TEMPLATE_A);
		expect(bucketContent('B', subjectTest, content)).toEqual({
			...content,
			subject: 'Alternate subject',
		});
	});

	it('skips a bucket whose template has no content in its language', () => {
		expect(bucketContent(undefined, campaign(), null)).toBeNull();
	});
});

describe('decidePageEnd', () => {
	const hop = pageHop();

	it('bumps the daily count by what was enqueued and schedules the next page', () => {
		const end = decidePageEnd({
			page: { nextCursor: 'next', pageCandidates: 500 },
			pageEnqueued: 480,
			slice: hop.slice,
			planCheckpoint: hop.planCheckpoint,
		});
		expect(end).toEqual({
			dailySendCount: 480,
			advance: { nextCursor: 'next', pageEnqueued: 480, pageCandidates: 500 },
			planDay: { ...hop.planCheckpoint, enqueuedToday: 480 },
			isLastPage: false,
		});
	});

	it('bumps nothing on a page that enqueued nobody and ends the walk on the last page', () => {
		const end = decidePageEnd({
			page: { nextCursor: null, pageCandidates: 0 },
			pageEnqueued: 0,
			slice: hop.slice,
			planCheckpoint: hop.planCheckpoint,
		});
		expect(end.dailySendCount).toBeUndefined();
		expect(end.isLastPage).toBe(true);
	});
});
