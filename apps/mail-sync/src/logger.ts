import pino from 'pino';

export const logger = pino({
	name: 'owlat-mail-sync',
	level: process.env['LOG_LEVEL'] ?? 'info',
});
