/** Reserve and resolve the one irreversible SMTP transaction for a queue job. */

import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import type { EmailJob } from '../types.js';
import { sendToMx } from '../smtp/sender.js';
import {
	finalizeSmtpOutcome,
	markSmtpOutcomeUncertain,
	releaseSmtpOutcome,
	reserveSmtpOutcome,
} from './smtpOutcomeJournal.js';
import type { SmtpOutcomeJournalEntry } from './smtpOutcomeJournal.js';
import { classifyResult, reduce } from '../dispatch/outcome.js';
import type { CtxWithIp } from '../dispatch/types.js';

type SendArguments = Parameters<typeof sendToMx>;
type EligibilityLease = SendArguments[4];
type CompletedJournal = Awaited<ReturnType<typeof finalizeSmtpOutcome>>;

export type JournaledSmtpAttempt =
	| { kind: 'capacity' }
	| { kind: 'retry_pre_data' }
	| { kind: 'effects_applied' }
	| { kind: 'completed'; journal: CompletedJournal };

export async function runJournaledSmtpAttempt(options: {
	redis: Redis;
	config: MtaConfig;
	jobId: string;
	job: EmailJob;
	eligibilityLease: EligibilityLease;
	attempt: CtxWithIp;
	startedAt: number;
}): Promise<JournaledSmtpAttempt> {
	const reservation = await reserveSmtpOutcome(
		options.redis,
		options.jobId,
		options.job.messageId,
		options.attempt,
		{
			now: options.startedAt,
			capacity: options.config.smtpOutcomeJournalMaxSize,
		}
	);
	if (reservation.kind === 'capacity') return { kind: 'capacity' };

	if (reservation.kind === 'existing') {
		const replay = await resumeJournaledSmtpAttempt(options.redis, reservation, options.job);
		return replay.kind === 'retry_pre_data' ? runJournaledSmtpAttempt(options) : replay;
	}

	let activeJournal = { entry: reservation.entry, raw: reservation.raw };
	let result: Awaited<ReturnType<typeof sendToMx>>;
	try {
		result = await sendToMx(
			options.job,
			options.config,
			options.redis,
			reservation.entry.attempt.ip,
			options.eligibilityLease,
			reservation.entry.attempt.destination,
			async () => {
				activeJournal = await markSmtpOutcomeUncertain(
					options.redis,
					activeJournal.entry,
					activeJournal.raw
				);
			}
		);
	} catch (error) {
		if (activeJournal.entry.phase === 'pre_data') {
			await releaseSmtpOutcome(options.redis, activeJournal.entry, activeJournal.raw).catch(
				() => {}
			);
		}
		throw error;
	}
	const completedAt = Date.now();
	return {
		kind: 'completed',
		journal: await completeAttempt(
			options.redis,
			activeJournal.entry,
			activeJournal.raw,
			options.job,
			result,
			completedAt - options.startedAt,
			completedAt
		),
	};
}

/** Resolve stored SMTP state without re-entering mutable pre-SMTP policy. */
export async function resumeJournaledSmtpAttempt(
	redis: Redis,
	journal: { entry: SmtpOutcomeJournalEntry; raw: string },
	job: EmailJob
): Promise<Exclude<JournaledSmtpAttempt, { kind: 'capacity' }>> {
	if (journal.entry.state === 'effects_applied') return { kind: 'effects_applied' };
	if (journal.entry.state === 'completed') {
		return { kind: 'completed', journal: { entry: journal.entry, raw: journal.raw } };
	}
	if (journal.entry.phase === 'pre_data') {
		if (!(await releaseSmtpOutcome(redis, journal.entry, journal.raw))) {
			throw new Error('SMTP pre-DATA journal replay lost ownership');
		}
		return { kind: 'retry_pre_data' };
	}
	return {
		kind: 'completed',
		journal: await completeAttempt(
			redis,
			journal.entry,
			journal.raw,
			job,
			{
				success: false,
				bounceType: 'ambiguous',
				error: 'SMTP outcome unknown after worker interruption',
			},
			0,
			Date.now()
		),
	};
}

async function completeAttempt(
	redis: Redis,
	entry: Parameters<typeof finalizeSmtpOutcome>[1],
	expectedRaw: string,
	job: EmailJob,
	result: Parameters<typeof finalizeSmtpOutcome>[3],
	durationMs: number,
	completedAt: number
): Promise<CompletedJournal> {
	const attemptCtx = { ...entry.attempt, job, durationMs };
	const outcome = classifyResult(result, entry.attempt.destination.providerKey);
	const reduction = reduce(outcome, attemptCtx);
	return finalizeSmtpOutcome(redis, entry, expectedRaw, result, durationMs, outcome, reduction, {
		now: completedAt,
	});
}
