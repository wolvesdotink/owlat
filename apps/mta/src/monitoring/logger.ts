/**
 * Structured JSON logging via Pino
 */

import pino from 'pino';

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
});
