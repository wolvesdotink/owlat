import type { ReservedJob } from 'groupmq';
import type { EmailJob } from '../types.js';

/** The two defer sources used by dispatch logging and telemetry. */
export type DeferKind = 'self_throttle' | 'remote_4xx';

/** Add ±15% jitter so simultaneous deferrals do not form a retry herd. */
export function withJitter(delayMs: number): number {
	const jitterFactor = 0.85 + Math.random() * 0.3;
	return Math.round(delayMs * jitterFactor);
}

/** Wall-clock age measured from the first enqueue, including legacy jobs. */
export function messageAgeMs(job: ReservedJob<EmailJob>, now: number): number {
	const firstEnqueuedAt = job.data.firstEnqueuedAt ?? job.timestamp;
	return now - firstEnqueuedAt;
}
