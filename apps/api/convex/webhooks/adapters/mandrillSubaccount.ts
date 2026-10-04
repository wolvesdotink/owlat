/**
 * Which Mandrill webhook events are about Owlat's own traffic (#1243).
 *
 * A Mandrill webhook belongs to the whole ACCOUNT, so on an account shared with
 * other senders it carries every subaccount's events, each naming its origin in
 * `msg.subaccount`. `MANDRILL_SUBACCOUNT` is how an operator puts Owlat's
 * traffic in a subaccount of its own: the send path sends under it and the
 * `rejects/list` carry-over imports only its blacklist. The webhook has to draw
 * the same line, because two events act on an ADDRESS without a matching Send:
 * `unsub` unsubscribes the contact, and a `reject` blocklists the address before
 * the Send is looked up. Another subaccount's opt-out or blacklist rule would
 * otherwise unsubscribe or block a contact who never opted out of, or bounced,
 * Owlat mail.
 *
 * THE RULE: an event is ours when its subaccount is one Owlat sends under. Each
 * configured Mandrill transport (the default one and every named
 * `mandrill#<key>` instance) contributes the subaccount it sends under, read
 * exactly as the send adapter reads it: the raw value, with an empty one meaning
 * "none". A transport with no subaccount sends on the account's default, whose
 * events carry none, so it contributes "none".
 *
 * Three consequences, each deliberate:
 *
 *  - With no subaccount configured anywhere, events that carry no subaccount are
 *    handled exactly as before, so a single-tenant account changes nothing. An
 *    event that DOES carry one cannot be about Owlat's mail, which carried none,
 *    so it is dropped too: that is the same bug for the common layout where
 *    Owlat sends on the account's default and other teams use subaccounts.
 *  - The filter covers every event kind, including events whose message id
 *    would match an Owlat Send. Mandrill message ids are unique across the
 *    account, so a foreign event can only match one if Owlat sent that message
 *    under a subaccount it no longer uses. Feedback for mail sent before an
 *    operator changes the setting is therefore ignored once it changes. The
 *    carry-over import draws the same line, and keeping the decision here, in
 *    one place before anything is dispatched, means no event kind can leak
 *    through a path that was not taught about subaccounts.
 *  - A `subaccount` that is not a string matches nothing, so an event whose
 *    origin cannot be read is not trusted into an address-keyed effect.
 */

import { listSendTransports } from '../../lib/sendProviders/transports';
import { transportEnvOptional } from '../../lib/sendProviders/transportEnv';

/** A subaccount id, `null` for the account's default, `undefined` for unreadable. */
type SubaccountOrigin = string | null | undefined;

/** The subaccount an event came from, normalized the way the send path reads its own. */
function originOf(item: unknown): SubaccountOrigin {
	const msg = (item as { msg?: unknown } | null | undefined)?.msg;
	if (msg === null || typeof msg !== 'object') return null;
	const subaccount = (msg as { subaccount?: unknown }).subaccount;
	if (subaccount === undefined || subaccount === null || subaccount === '') return null;
	return typeof subaccount === 'string' ? subaccount : undefined;
}

/**
 * Every subaccount Owlat's Mandrill traffic is sent under, `null` meaning the
 * account's default. Resolved per batch, so an env change applies to the next
 * webhook without a redeploy.
 */
export function ownMandrillSubaccounts(): ReadonlySet<string | null> {
	const own = new Set<string | null>();
	for (const transport of listSendTransports()) {
		if (transport.kind !== 'mandrill') continue;
		own.add(transportEnvOptional(transport, 'MANDRILL_SUBACCOUNT') || null);
	}
	return own;
}

/** The items of one `mandrill_events` batch that came from Owlat's own subaccounts. */
export function ownSubaccountItems<T>(items: readonly T[]): T[] {
	const own = ownMandrillSubaccounts();
	return items.filter((item) => {
		const origin = originOf(item);
		return origin !== undefined && own.has(origin);
	});
}
