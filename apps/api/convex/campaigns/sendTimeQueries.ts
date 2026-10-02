/**
 * Send-time optimization reads (ADR-0068): the planning context the send
 * walker loads once per page, and the predicted distribution the schedule
 * panel shows before the campaign is scheduled.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { campaignsQuery } from './_helpers';
import { getOrThrow, throwInvalidInput } from '../_utils/errors';
import { COUNT_PAGE_SIZE, resolveRecipientPageImpl } from './audienceResolution';
import { peakHour, type SendTimeHistogram } from '../analytics/sendTimeProfile';
import { readDefaultTimezone, readOrganizationHistogram } from '../analytics/sendTimeProfileSync';
import {
	makeSendTimePlanner,
	resolveSendTimeWindow,
	sendTimeSettingsError,
	type SendTimeSource,
} from './sendTimeOptimization';

/** What the walker needs besides the page itself. */
export const getPlanningContext = internalQuery({
	args: {},
	handler: async (
		ctx
	): Promise<{ organization: SendTimeHistogram | null; defaultTimezone: string | undefined }> => ({
		organization: await readOrganizationHistogram(ctx.db),
		defaultTimezone: await readDefaultTimezone(ctx.db),
	}),
});

const HOUR_MS = 3_600_000;

export interface SendTimePreview {
	/** One bucket per clock hour the window touches, from the start's hour. */
	hours: { at: number; count: number }[];
	/** Recipients the prediction was computed from. */
	sampleSize: number;
	/** The sample is the first page of a larger audience, not all of it. */
	isSample: boolean;
	sources: Record<SendTimeSource, number>;
	/** The organization's busiest local hour, or null without enough history. */
	organizationBestHour: number | null;
}

/**
 * The predicted sends per hour for a campaign scheduled at `startAt` with
 * these settings. Bounded: it plans the audience's first page (the wizard
 * count's page size), and says so when the audience is larger, so the panel
 * can present the bars as shares rather than exact counts.
 */
// all-members: per-hour counts for the campaign wizard every member can open; no contact data leaves
// token-safe: returns counts only, never a contact row
export const previewSendTimes = campaignsQuery({
	args: {
		campaignId: v.id('campaigns'),
		startAt: v.number(),
		windowHours: v.number(),
		holdoutPercent: v.number(),
		scheduledHour: v.optional(v.number()),
		scheduledMinute: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<SendTimePreview> => {
		const settings = { windowHours: args.windowHours, holdoutPercent: args.holdoutPercent };
		const error = sendTimeSettingsError(settings);
		if (error) throwInvalidInput(error);

		const campaign = await getOrThrow(ctx, args.campaignId, 'Campaign');
		const window = resolveSendTimeWindow({
			sentAt: args.startAt,
			windowHours: args.windowHours,
			now: args.startAt,
		});
		// Buckets on whole hours, so a bar's label is the hour its sends go out
		// in (a start at 10:25 opens with a 10:00 bucket).
		const firstHour = Math.floor(window.startAt / HOUR_MS) * HOUR_MS;
		const hours = Array.from(
			{ length: Math.ceil((window.endAt - firstHour) / HOUR_MS) },
			(_, i) => ({ at: firstHour + i * HOUR_MS, count: 0 })
		);
		const sources: Record<SendTimeSource, number> = {
			contact: 0,
			organization: 0,
			start: 0,
			holdout: 0,
		};
		const organization = await readOrganizationHistogram(ctx.db);
		const organizationBestHour = peakHour(organization);
		if (!campaign.audience) {
			return { hours, sampleSize: 0, isSample: false, sources, organizationBestHour };
		}

		const page = await resolveRecipientPageImpl(ctx, {
			audience: campaign.audience,
			cursor: '',
			numItems: COUNT_PAGE_SIZE,
		});
		const plan = makeSendTimePlanner({
			campaignId: args.campaignId,
			settings,
			window,
			organization,
			defaultTimezone: await readDefaultTimezone(ctx.db),
			startWallClock:
				args.scheduledHour !== undefined && args.scheduledMinute !== undefined
					? { hour: args.scheduledHour, minute: args.scheduledMinute }
					: undefined,
			// The preview judges evidence as of the start, as the walker will.
			now: args.startAt,
		});
		for (const recipient of page.recipients) {
			const planned = plan(recipient);
			sources[planned.source]++;
			const index = Math.min(
				hours.length - 1,
				Math.max(0, Math.floor((planned.at - firstHour) / HOUR_MS))
			);
			hours[index]!.count++;
		}
		return {
			hours,
			sampleSize: page.recipients.length,
			isSample: page.nextCursor !== null,
			sources,
			organizationBestHour,
		};
	},
});
