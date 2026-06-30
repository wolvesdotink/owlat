import pino from 'pino';

export const logger = pino({
	name: 'owlat-imap',
	level: process.env['LOG_LEVEL'] ?? 'info',
});
