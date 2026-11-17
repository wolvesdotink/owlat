/**
 * Mail to the signed `mailto:` unsubscribe target this MTA puts in the
 * `List-Unsubscribe` header of a marketing message (`smtp/send/compose.ts`).
 *
 * Possession of the signed address is the request: the body, the subject and
 * the sender are ignored, because mail clients that act on a mailto target send
 * whatever they like, and gateways rewrite the rest. The token is verified with
 * the VERP key; a valid one becomes an `unsubscribed` event to Convex, which
 * applies the same unsubscribe the HTTPS one-click does. A forged or expired
 * one is counted and dropped. Either way the listener answers 250: nothing is
 * ever sent back, so the address cannot be used to make this host mail anyone.
 *
 * Repeats of one address share an outbox slot keyed by the message, and
 * Convex's unsubscribe is idempotent, so mailing it twice unsubscribes once.
 */

import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { verifyUnsubscribeAddress } from '@owlat/shared/verp';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';
import { unsubscribeMailTotal } from '../monitoring/collector.js';
import { queueConvexWebhook } from '../webhooks/convexNotifier.js';
import { resolveSignedTokenKey } from './signedToken.js';
import { TransientFeedbackProcessingError } from './transientFeedbackError.js';

/** Verify one unsubscribe address and report it. Throws only when the outbox is unavailable. */
export async function recordMailedUnsubscribe(
	recipient: string,
	deps: { redis: Redis; config: MtaConfig },
	now: number = Date.now()
): Promise<void> {
	const verdict = verifyUnsubscribeAddress(recipient, resolveSignedTokenKey(), now);
	if (verdict.kind !== 'valid') {
		unsubscribeMailTotal.inc({ outcome: verdict.kind });
		logger.warn({ outcome: verdict.kind }, 'Unsubscribe mail with an unusable token dropped');
		return;
	}
	const identity = createHash('sha256').update(verdict.messageId, 'utf8').digest('hex');
	try {
		await queueConvexWebhook(
			{
				event: 'unsubscribed',
				eventId: `unsubscribe:${identity}`,
				messageId: verdict.messageId,
				timestamp: now,
			},
			deps.config,
			deps.redis,
			`unsubscribe:${identity}`
		);
	} catch (err) {
		throw new TransientFeedbackProcessingError('Unsubscribe outbox unavailable', err);
	}
	unsubscribeMailTotal.inc({ outcome: 'accepted' });
}
