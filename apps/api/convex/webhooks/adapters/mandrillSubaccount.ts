/**
 * Marking Mandrill webhook events from other subaccounts (#1243).
 *
 * A Mandrill webhook belongs to the whole ACCOUNT, so on an account shared with
 * other senders it carries every subaccount's events, each naming its origin in
 * `msg.subaccount`. `MANDRILL_SUBACCOUNT` is how an operator puts Owlat's
 * traffic in a subaccount of its own: the send path sends under it and the
 * `rejects/list` carry-over imports only its blacklist.
 *
 * An event is IN SCOPE when its subaccount is one Owlat sends under, as
 * `ownMandrillSubaccounts` answers it: one per configured Mandrill transport,
 * read the way the send adapter reads it, with `null` standing for the
 * account's default. Every other event is still mapped, but carries
 * `outsideSendingScope`, and the dispatcher applies it only when it attributes
 * to one of our Sends (`../sendingScope.ts`). It is marked rather than dropped
 * because the subaccount alone cannot prove an event foreign: a Mandrill rule
 * can move Owlat's mail into a subaccount, and mail sent before the setting
 * changed carries the old one.
 *
 * A `subaccount` that is not a string is never in scope, so an event whose
 * origin cannot be read is held to the same attribution.
 */

import { ownMandrillSubaccounts } from '../../lib/sendProviders/mandrill/subaccounts';
import type { InboundEvent } from '../types';

interface MandrillItemOrigin {
	msg?: { email?: unknown; subaccount?: unknown } | null;
}

/** A subaccount id, `null` for the account's default, `undefined` for unreadable. */
function originOf(item: MandrillItemOrigin | null | undefined): string | null | undefined {
	const msg = item?.msg;
	if (msg === null || typeof msg !== 'object') return null;
	const subaccount = msg.subaccount;
	if (subaccount === undefined || subaccount === null || subaccount === '') return null;
	return typeof subaccount === 'string' ? subaccount : undefined;
}

/**
 * Map one `mandrill_events` batch, marking every event that came from outside
 * Owlat's own subaccounts. The mark carries `msg.email`, which attribution
 * compares with the Send's recipient.
 */
export function mapMarkingSendingScope<T extends MandrillItemOrigin>(
	items: readonly T[],
	map: (item: T) => InboundEvent | null
): InboundEvent[] {
	const own = ownMandrillSubaccounts();
	const events: InboundEvent[] = [];
	for (const item of items) {
		const event = map(item ?? ({} as T));
		if (!event) continue;
		const origin = originOf(item);
		if (origin !== undefined && own.has(origin)) {
			events.push(event);
			continue;
		}
		const email = item?.msg?.email;
		const recipient = typeof email === 'string' && email ? email : undefined;
		events.push(Object.assign({}, event, { outsideSendingScope: recipient ? { recipient } : {} }));
	}
	return events;
}
