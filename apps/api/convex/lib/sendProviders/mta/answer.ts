/**
 * Reading the MTA's 2xx `/send` answer (`MtaSendAccepted`: `{ success: true, id }`).
 *
 * Each body maps onto one branch of the send-result state machine:
 *
 *   - `accepted`: `success` is true and `id` a non-empty string.
 *   - `unreadable`: the body is `null`. Acceptance cannot be told from it, so
 *     the caller reports `acceptanceUnknown` and reconciliation replays it.
 *   - `refused`: anything else, a JSON scalar or array included. A definite
 *     failure, never `acceptanceUnknown`: that would send a custody-taking
 *     transport into a reconciliation replay for a body that is just nonsense.
 *     A `success: true` whose `id` is missing or not a string is refused too,
 *     so an unusable id never becomes a message id; the MTA deduplicates the
 *     retry by its idempotency key.
 *
 * A body that is not JSON at all never gets here: its read throws, and the
 * caller's transport catch reports it `acceptanceUnknown`.
 */

import { isRecord } from '@owlat/shared/utils/guards';

export type MtaSendAnswer =
	| { readonly kind: 'accepted'; readonly id: string }
	| { readonly kind: 'unreadable'; readonly reason: string }
	| { readonly kind: 'refused'; readonly error?: string };

export function readMtaSendAnswer(body: unknown): MtaSendAnswer {
	if (body === null) return { kind: 'unreadable', reason: 'MTA returned a null answer' };
	if (!isRecord(body)) return { kind: 'refused' };
	const id = body['id'];
	if (body['success'] === true && typeof id === 'string' && id !== '') {
		return { kind: 'accepted', id };
	}
	// Only the MTA's own `error` text is surfaced; any other value is not prose.
	const error = body['error'];
	return typeof error === 'string' ? { kind: 'refused', error } : { kind: 'refused' };
}
