/**
 * Structured JSON logging via Pino
 */

import pino from 'pino';
import { LOG_REDACT_PATHS, logRedactCensor } from '@owlat/shared/logRedaction';
import { logEventBindings } from '@owlat/shared/logEvent';
import type { EmailJob } from '../types.js';

export const logger = pino({
	level: process.env['LOG_LEVEL'] ?? 'info',
	transport:
		process.env['NODE_ENV'] === 'development'
			? { target: 'pino-pretty', options: { colorize: true } }
			: undefined,
	base: {
		service: 'owlat-mta',
		pid: process.pid,
	},
	timestamp: pino.stdTimeFunctions.isoTime,
	// Every address and subject this process logs is de-identified here rather
	// than at the ~60 call sites, so a new `logger.info({ rcptTo }, …)` is safe
	// the day it is written. The censor keeps the domain and a stable digest, so
	// an operator can still follow one recipient across MTA and Convex lines.
	redact: { paths: LOG_REDACT_PATHS, censor: logRedactCensor },
});

/**
 * A child logger bound to one job's identities, under the same key names the
 * Convex backend's `logEvent` lines use (`@owlat/shared/logEvent`): `orgId`,
 * `messageId`, `workAttemptId`, `correlationId`. Filtering any of them finds
 * the job's lines on both sides of the wire.
 */
export function jobLogger(
	job: Partial<Pick<EmailJob, 'organizationId' | 'messageId' | 'workAttemptId' | 'correlationId'>>
): pino.Logger {
	return logger.child(
		logEventBindings({
			orgId: job.organizationId,
			messageId: job.messageId,
			workAttemptId: job.workAttemptId,
			correlationId: job.correlationId,
		})
	);
}
