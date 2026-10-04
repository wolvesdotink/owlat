/**
 * Feedback from outside this deployment's sending scope (#1243).
 *
 * A Mandrill webhook belongs to the whole ACCOUNT, so on an account shared with
 * other senders it carries every subaccount's events. Two of them act on an
 * ADDRESS without a matching Send: `unsub` unsubscribes the contact, and a
 * `reject` blocklists the address before the Send is looked up. Another
 * subaccount's opt-out or blacklist rule must not reach an Owlat contact.
 *
 * The adapter cannot tell from the event alone whether it is ours: Mandrill
 * rules can move Owlat's own mail into a subaccount, and mail sent before an
 * operator changed `MANDRILL_SUBACCOUNT` carries the old one. So it marks such
 * an event ({@link OutsideSendingScope}) instead of dropping it, and this module
 * decides at dispatch, where the database is:
 *
 *  - an event that matches one of our Sends (same provider message id, same
 *    provider kind, same recipient) is applied as usual, whatever subaccount it
 *    names. People unsubscribe from old mail at any time;
 *  - an event whose id names a Send that is NOT that match is dropped;
 *  - an event whose id names no Send acts on no address. An `unsub` is
 *    dropped. A `reject` is dropped whole: a message Mandrill refuses from its
 *    reject list is refused in the send response, which carries the same
 *    suppression and is recorded there before the send fails
 *    (`delivery/governedDispatch.ts`), so an unmatched `reject` is either
 *    already applied or not ours. A bounce or complaint goes down the ordinary
 *    unknown-message path (`./unresolvedBounce.ts`), which already acts on no
 *    address, and is stored with a keyed hash of the recipient so a replay,
 *    once the Send's id lands, checks the provider kind and the recipient again
 *    (`./unresolvedFeedback.ts`). A `send` or `deferral` for no Send moves
 *    nothing either way.
 *
 * A dropped event is never claimed, so it costs no replay key. The lookup is
 * `./sendingScopeQueries.ts`.
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import type { InboundEvent } from './types';

/**
 * The event the dispatcher should apply, or null to drop it. An unmarked event
 * comes back unchanged.
 */
export async function withinSendingScope(
	ctx: ActionCtx,
	event: InboundEvent
): Promise<InboundEvent | null> {
	const scope = 'outsideSendingScope' in event ? event.outsideSendingScope : undefined;
	if (!scope) return event;
	const providerMessageId = 'providerMessageId' in event ? event.providerMessageId : undefined;
	const providerType = 'providerType' in event ? event.providerType : undefined;
	if (!providerMessageId || !providerType) return null;
	const match = await ctx.runQuery(internal.webhooks.sendingScopeQueries.matchSendingScope, {
		providerMessageId,
		providerType,
		...(scope.recipient ? { recipient: scope.recipient } : {}),
	});
	if (match === 'attributed') return event;
	if (match === 'mismatch') return null;
	// No Send carries this id. An `unsub` acts only on an address. A `reject` is
	// dropped whole, with no lifecycle attempt: if the message was ours, Mandrill
	// refused it in the send response, which carried the same suppression and
	// was recorded then (`delivery/governedDispatch.ts`), and the completion
	// failed the Send; if it was not ours, ignoring it is the fix.
	if (event.kind === 'email.unsubscribed' || event.kind === 'email.failed') return null;
	return event;
}
