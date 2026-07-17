/**
 * Small private helpers for the MX / bounce listener (`server.ts`): the
 * per-classification log line and the local-address predicate. Split out to keep
 * `server.ts` under the file-size cap while the listener hooks live together.
 */

import type { ParsedMessage } from '@owlat/mail-message';
import { logger } from '../monitoring/logger.js';
import { addressText } from '../inbound/parsedAddress.js';
import type { BounceAttempt } from './types.js';

/**
 * Per-classification log line. Replaces the inline `logger.info(...)` calls that
 * lived inside each branch of the old `onData` switch.
 */
export function logAttempt(attempt: BounceAttempt, parsed: ParsedMessage): void {
	switch (attempt.kind) {
		case 'fbl':
			logger.info(
				{ messageId: attempt.arf.originalMessageId, type: 'complaint' },
				'FBL complaint processed'
			);
			return;
		case 'dsn_attributed':
			logger.info(
				{
					messageId: attempt.bounce.originalMessageId,
					bounceType: attempt.bounce.bounceType,
					type: 'bounce',
				},
				'Bounce DSN processed'
			);
			return;
		case 'route_hold':
			logger.info({ rcptTo: attempt.rcptTo, from: addressText(parsed.from) }, 'Inbound email held');
			return;
		case 'route_bounce':
			logger.info({ rcptTo: attempt.rcptTo }, 'Inbound email bounced by route');
			return;
		case 'unrecognized':
			logger.warn(
				{ rcptTo: attempt.rcptTo, subject: parsed.subject },
				'Received unrecognized inbound email'
			);
			return;
		case 'dsn_unattributed':
		case 'mailbox':
		case 'endpoint_forward':
		case 'inbound_accept':
			// No top-level log line in the pre-deepening handler.
			return;
	}
}

/**
 * Check if an IP is a local/loopback address (skip tarpit for these).
 */
export function isLocalAddress(ip: string): boolean {
	return (
		ip === '127.0.0.1' ||
		ip === '::1' ||
		ip === '::ffff:127.0.0.1' ||
		ip.startsWith('10.') ||
		ip.startsWith('172.16.') ||
		ip.startsWith('192.168.')
	);
}
