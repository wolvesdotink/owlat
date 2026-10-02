/**
 * Build send-time profiles from the campaign sends that already exist
 * (ADR-0068, migration 0064).
 *
 * New reader opens and clicks fold into a contact's `sendTimeProfile` as they
 * happen (analytics/sendTimeProfileSync.ts). This back-fill gives the contacts
 * who engaged before that a profile too, and rebuilds the organization
 * histogram from the same events, so "Optimized per contact" has history to
 * work with from the first campaign.
 *
 *   npx convex run migrations/0064_backfill_send_time_profiles:run
 *
 * WHAT COUNTS. A contact's latest `SENDS_PER_CONTACT` campaign sends: the first
 * reader click (`clickedAt`) of a send whose campaign filtered automated
 * clicks, and the first reader open (`openedAt`) of a send whose campaign
 * filtered automated opens. Campaigns sent before those filters existed may
 * have counted Apple Mail Privacy Protection and scanner fetches, so their
 * opens and clicks are left out.
 *
 * SAFE AT ANY POINT: the planner reads whatever profile a contact has, and a
 * contact without one falls back to the organization histogram and then to the
 * start time. Nothing waits on this.
 *
 * DURABLE AND RESUMABLE (lib/migrationLedger.ts): each page records its cursor
 * and counts in the same transaction as its writes. Running `run` again
 * resumes an unfinished pass; `'{"restart":true}'` starts over.
 *
 * IDEMPOTENT. A contact's profile is REBUILT from its sends, not added to, so a
 * redone page writes the same profile. The organization histogram is cleared
 * when a fresh pass starts and every page adds the events it rebuilt; a live
 * engagement on a contact the pass has not reached yet is counted twice in the
 * organization histogram, which is a few events in an aggregate that decays.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { logInfo } from '../lib/runtimeLog';
import { localTimeParts } from '../lib/emailHelpers';
import {
	effectiveTimeZone,
	foldEngagement,
	type SendTimeEngagementKind,
	type SendTimeHistogram,
} from '../analytics/sendTimeProfile';
import {
	addToOrganizationHistogram,
	clearOrganizationHistogram,
	readDefaultTimezone,
} from '../analytics/sendTimeProfileSync';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationPage,
} from '../lib/migrationLedger';

const MIGRATION = '0064_backfill_send_time_profiles';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.8';

/**
 * Contacts per page. Each reads up to `SENDS_PER_CONTACT` sends (a send row is
 * around 1 KB), so a page stays near 2,400 documents and a few MB.
 */
const PAGE_SIZE = 40;

/**
 * Sends read per contact, newest first. With a 60-day half-life, a send older
 * than the last sixty a contact received carries almost no weight.
 */
export const SENDS_PER_CONTACT = 60;

type CampaignFilters = Pick<
	Doc<'campaigns'>,
	'isAutomatedOpenFiltered' | 'isAutomatedClickFiltered'
>;

/** The reader engagements a contact's sends hold, oldest first. */
export function engagementsFromSends(
	sends: ReadonlyArray<Pick<Doc<'emailSends'>, 'campaignId' | 'openedAt' | 'clickedAt'>>,
	filtersOf: (campaignId: Id<'campaigns'>) => CampaignFilters | null
): { at: number; kind: SendTimeEngagementKind }[] {
	const events: { at: number; kind: SendTimeEngagementKind }[] = [];
	for (const send of sends) {
		const filters = filtersOf(send.campaignId);
		if (!filters) continue;
		if (filters.isAutomatedOpenFiltered === true && send.openedAt !== undefined) {
			events.push({ at: send.openedAt, kind: 'open' });
		}
		if (filters.isAutomatedClickFiltered === true && send.clickedAt !== undefined) {
			events.push({ at: send.clickedAt, kind: 'click' });
		}
	}
	return events.sort((a, b) => a.at - b.at);
}

type PageResult = {
	cursor: string;
	isDone: boolean;
	scanned: number;
	changed: number;
	isSuperseded?: boolean;
};

async function rebuildPage(ctx: MutationCtx, cursor: string | null): Promise<PageResult> {
	const { page, continueCursor, isDone } = await ctx.db
		.query('contacts')
		.paginate({ numItems: PAGE_SIZE, cursor });
	const defaultTimezone = await readDefaultTimezone(ctx.db);
	const campaigns = new Map<Id<'campaigns'>, CampaignFilters | null>();
	const filtersOf = (id: Id<'campaigns'>) => campaigns.get(id) ?? null;
	let organization: SendTimeHistogram | null = null;
	let changed = 0;

	for (const contact of page) {
		if (contact.deletedAt !== undefined) continue;
		const sends = await ctx.db
			.query('emailSends')
			.withIndex('by_contact', (q) => q.eq('contactId', contact._id))
			.order('desc')
			.take(SENDS_PER_CONTACT);
		for (const send of sends) {
			if (!campaigns.has(send.campaignId)) {
				const campaign = await ctx.db.get(send.campaignId);
				campaigns.set(send.campaignId, campaign);
			}
		}
		const events = engagementsFromSends(sends, filtersOf);
		if (events.length === 0) {
			if (contact.sendTimeProfile !== undefined) {
				await ctx.db.patch(contact._id, { sendTimeProfile: undefined });
				changed++;
			}
			continue;
		}

		const timeZone = effectiveTimeZone(contact.timezone, defaultTimezone);
		let profile: SendTimeHistogram | null = null;
		for (const event of events) {
			const local = localTimeParts(event.at, timeZone);
			const placed = { ...event, hour: local.hour, weekday: local.weekday };
			profile = foldEngagement(profile, placed);
			organization = foldEngagement(organization, placed);
		}
		await ctx.db.patch(contact._id, { sendTimeProfile: { ...profile!, timeZone } });
		changed++;
	}

	if (organization) await addToOrganizationHistogram(ctx, organization);
	return { cursor: continueCursor, isDone, scanned: page.length, changed };
}

/** Rebuild one page of contacts; while `generation` is current, schedules the next page. */
export const backfillPage = internalMutation({
	args: {
		cursor: v.union(v.string(), v.null()),
		generation: v.number(),
	},
	handler: async (ctx, args): Promise<PageResult> => {
		const run = await readMigrationRun(ctx, MIGRATION);
		if (!run || !isCurrentMigrationPage(run, args.generation)) {
			logInfo('migration.0064_backfill_send_time_profiles.superseded', {
				generation: args.generation,
			});
			return {
				cursor: args.cursor ?? '',
				isDone: false,
				scanned: 0,
				changed: 0,
				isSuperseded: true,
			};
		}

		const result = await rebuildPage(ctx, args.cursor);
		await recordMigrationPage(ctx, run, {
			cursor: result.cursor,
			isDone: result.isDone,
			scanned: result.scanned,
			changed: result.changed,
		});
		logInfo('migration.0064_backfill_send_time_profiles.page', {
			scanned: result.scanned,
			changed: result.changed,
			isDone: result.isDone,
			generation: run.generation,
		});
		if (!result.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.migrations['0064_backfill_send_time_profiles'].backfillPage,
				{ cursor: result.cursor, generation: run.generation }
			);
		}
		return result;
	},
});

/**
 * Start the background walk, or resume an unfinished one from its recorded
 * cursor. A finished migration is left alone unless `restart` is set. A pass
 * that starts from the first contact clears the organization histogram first,
 * because its pages rebuild it.
 */
export const run = internalMutation({
	args: { restart: v.optional(v.boolean()) },
	handler: async (
		ctx,
		args
	): Promise<{ started: boolean; generation?: number; reason?: string }> => {
		const begun = await beginMigrationRun(ctx, {
			migration: MIGRATION,
			introducedIn: INTRODUCED_IN,
			restart: args.restart,
		});
		if (!begun) {
			return { started: false, reason: 'Already completed; pass restart to run it again' };
		}
		if (begun.cursor === undefined) await clearOrganizationHistogram(ctx);
		await ctx.scheduler.runAfter(
			0,
			internal.migrations['0064_backfill_send_time_profiles'].backfillPage,
			{ cursor: begun.cursor ?? null, generation: begun.generation }
		);
		logInfo('migration.0064_backfill_send_time_profiles.started', {
			generation: begun.generation,
			pageCount: begun.pageCount,
		});
		return { started: true, generation: begun.generation };
	},
});
