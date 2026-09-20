import pino from 'pino';
import { LOG_REDACT_PATHS, logRedactCensor } from '@owlat/shared/logRedaction';

export const logger = pino({
	name: 'owlat-imap',
	level: process.env['LOG_LEVEL'] ?? 'info',
	// Addresses and subjects are de-identified centrally; see the MTA logger for
	// the reasoning and @owlat/shared/logRedaction for the censor.
	redact: { paths: LOG_REDACT_PATHS, censor: logRedactCensor },
});
