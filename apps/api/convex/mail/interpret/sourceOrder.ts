/**
 * A Postbox interpretation source's place in its thread, as one sortable
 * string (`interpretSources.sourceOrderKey`): the message's arrival time, then
 * its creation time, both fixed-width, so string order is thread order. The
 * D10 index (`by_mail_thread_deferred_order`) reads the oldest deferred
 * predecessor and the newest deferred source with one `first()` each
 * (`defer.ts`). Pure.
 */

import type { Doc } from '../../_generated/dataModel';

/** Wide enough for any millisecond timestamp, with the creation time's fraction. */
const AT_WIDTH = 16;
const CREATION_WIDTH = 20;

export function sourceOrderKey(
	message: Pick<Doc<'mailMessages'>, 'receivedAt' | '_creationTime'>
): string {
	const at = Math.max(0, Math.floor(message.receivedAt)).toString().padStart(AT_WIDTH, '0');
	const creation = Math.max(0, message._creationTime).toFixed(3).padStart(CREATION_WIDTH, '0');
	return `${at}:${creation}`;
}
