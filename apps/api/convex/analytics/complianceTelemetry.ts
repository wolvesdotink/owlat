/** Operator-facing sender-compliance telemetry for the Delivery dashboard. */

import { authedQuery } from '../lib/authedFunctions';
import { getUserIdFromSession } from '../lib/sessionOrganization';
import {
	GMAIL_BULK_SENDER_THRESHOLD,
	GMAIL_PROXIMITY_WARNING_THRESHOLD,
	readGmailVolumes,
	readUnsubscribeLatency,
	UNSUBSCRIBE_HONOR_WINDOW_MS,
} from '../delivery/complianceTelemetry';
import {
	SPAM_RATE_HARD_THRESHOLD,
	SPAM_RATE_INTERNAL_CLEAN_DAY_EVIDENCE_DAYS,
	SPAM_RATE_TARGET,
	summarizeSpamRate,
} from './spamRate';

// all-members: coarse singleton-org delivery counts/rates contain no recipient data or credentials.
export const getComplianceTelemetry = authedQuery({
	args: {},
	handler: async (ctx) => {
		await getUserIdFromSession(ctx);
		const now = Date.now();
		const [spamRate, gmailDomains, unsubscribe] = await Promise.all([
			summarizeSpamRate(ctx.db, { kind: 'org' }, now),
			readGmailVolumes(ctx.db, now),
			readUnsubscribeLatency(ctx.db, now),
		]);
		const highestVolumeDomain = gmailDomains[0] ?? null;
		return {
			spamRate: {
				...spamRate,
				target: SPAM_RATE_TARGET,
				hardThreshold: SPAM_RATE_HARD_THRESHOLD,
				internalCleanDaysRequired: SPAM_RATE_INTERNAL_CLEAN_DAY_EVIDENCE_DAYS,
			},
			gmail: {
				domains: gmailDomains,
				highestVolumeDomain,
				warningThreshold: GMAIL_PROXIMITY_WARNING_THRESHOLD,
				bulkSenderThreshold: GMAIL_BULK_SENDER_THRESHOLD,
				approachingBulkClassification:
					highestVolumeDomain !== null &&
					highestVolumeDomain.delivered24h >= GMAIL_PROXIMITY_WARNING_THRESHOLD,
				// Phase 2 resolves provider identity from MX. An hourly bucket can
				// overlap the exact trailing boundary, so expose that approximation.
				windowApproximationMinutes: 60,
			},
			unsubscribe: {
				...unsubscribe,
				honorWindowMs: UNSUBSCRIBE_HONOR_WINDOW_MS,
			},
		};
	},
});
