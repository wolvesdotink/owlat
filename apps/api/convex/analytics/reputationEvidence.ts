/**
 * The reads behind the reputation check: the evidence `reputationEnforcement`
 * decides on, the evidence `reputationResume` lifts a suspension on, and how a
 * blocked instance gets sending back, as the banner and the operator console
 * show it. One home so the hourly check, a platform admin's lift and the two
 * screens read the same numbers.
 *
 * Not a Convex function module.
 */

import type { Doc } from '../_generated/dataModel';
import type { DatabaseReader } from '../_generated/server';
import { readRecentGmailSpamReadings } from '../delivery/postmaster';
import type { GmailSpamReading, ReputationTrigger } from './reputationEnforcement';
import {
	REPUTATION_WINDOW_MS,
	describeSuspensionLift,
	resumeCondition,
	type ResumeCondition,
	type SuspensionLift,
} from './reputationResume';
import { summarize, type ReputationSummary } from './sendingReputation';

/** One reading per UTC day survives, so a domain's window holds about 30. */
const GMAIL_WINDOW_READINGS_LIMIT = 64;

export async function readEnforcementEvidence(
	db: DatabaseReader,
	now: number
): Promise<{ org: ReputationSummary; gmail: GmailSpamReading[]; now: number }> {
	return {
		org: await summarize(db, { kind: 'org' }),
		gmail: await readRecentGmailSpamReadings(db, now),
		now,
	};
}

export async function readResumeCondition(
	db: DatabaseReader,
	trigger: ReputationTrigger,
	org: ReputationSummary,
	now: number
): Promise<ResumeCondition> {
	const domain = trigger.domain;
	const gmail =
		trigger.code === 'gmail_spam_rate' && domain !== undefined
			? await db
					.query('googlePostmasterStats')
					.withIndex('by_domain_period', (q) =>
						q.eq('domain', domain).gte('periodStart', now - REPUTATION_WINDOW_MS)
					)
					.take(GMAIL_WINDOW_READINGS_LIMIT)
			: [];
	return resumeCondition(trigger, { org, gmail });
}

/** How sending comes back while it is suspended or banned; `null` while it is allowed. */
export async function readSuspensionLift(
	db: DatabaseReader,
	settings: Doc<'instanceSettings'> | null,
	now: number
): Promise<SuspensionLift | null> {
	const status = settings?.abuseStatus;
	if (status !== 'suspended' && status !== 'banned') return null;
	const trigger = settings?.abuseStatusTrigger;
	const condition =
		trigger && status === 'suspended'
			? await readResumeCondition(db, trigger, await summarize(db, { kind: 'org' }), now)
			: null;
	return describeSuspensionLift({
		status,
		trigger,
		isManualResumeRequired: settings?.isSendingResumeManual === true,
		condition,
	});
}
