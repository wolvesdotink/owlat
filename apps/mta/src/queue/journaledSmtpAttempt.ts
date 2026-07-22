/** Reserve and resolve the one irreversible SMTP transaction for a queue job. */

import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import type { EmailJob } from '../types.js';
import { sendToMx } from '../smtp/sender.js';
import { finalizeSmtpOutcome, reserveSmtpOutcome } from './smtpOutcomeJournal.js';

type SendArguments = Parameters<typeof sendToMx>;
type EligibilityLease = SendArguments[4];
type Destination = SendArguments[5];
type CompletedJournal = Awaited<ReturnType<typeof finalizeSmtpOutcome>>;

export type JournaledSmtpAttempt =
	| { kind: 'capacity' }
	| { kind: 'completed'; journal: CompletedJournal };

export async function runJournaledSmtpAttempt(options: {
	redis: Redis;
	config: MtaConfig;
	jobId: string;
	job: EmailJob;
	ip: string;
	eligibilityLease: EligibilityLease;
	destination: Destination;
	startedAt: number;
}): Promise<JournaledSmtpAttempt> {
	const reservation = await reserveSmtpOutcome(
		options.redis,
		options.jobId,
		options.job.messageId,
		{
			now: options.startedAt,
			capacity: options.config.webhookDlqMaxSize,
		}
	);
	if (reservation.kind === 'capacity') return { kind: 'capacity' };

	if (reservation.kind === 'existing') {
		if (reservation.entry.state === 'completed') {
			return { kind: 'completed', journal: { entry: reservation.entry, raw: reservation.raw } };
		}
		return {
			kind: 'completed',
			journal: await finalizeSmtpOutcome(
				options.redis,
				reservation.entry,
				reservation.raw,
				{
					success: false,
					bounceType: 'ambiguous',
					error: 'SMTP outcome unknown after worker interruption',
				},
				0,
				{ now: Date.now() }
			),
		};
	}

	const result = await sendToMx(
		options.job,
		options.config,
		options.redis,
		options.ip,
		options.eligibilityLease,
		options.destination
	);
	const completedAt = Date.now();
	return {
		kind: 'completed',
		journal: await finalizeSmtpOutcome(
			options.redis,
			reservation.entry,
			reservation.raw,
			result,
			completedAt - options.startedAt,
			{ now: completedAt }
		),
	};
}
