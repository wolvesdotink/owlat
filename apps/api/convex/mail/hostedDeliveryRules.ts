/**
 * Forwarding and the vacation reply act on a delivery Owlat itself receives:
 * hosted delivery schedules `deliveryHooks.runPostDelivery`, and nothing else
 * does. A connected mailbox (`kind: 'external'`) is delivered to by its
 * provider and synced in afterwards, so neither rule can run for it:
 *
 *   - its normal mail goes out through the provider's SMTP, which the mail-sync
 *     worker drives only for a user's own send; the hook sends through Owlat's
 *     MTA, under an address the instance usually cannot sign (gmail.com);
 *   - synced mail carries no SMTP envelope, so the null-sender guard that keeps
 *     a reply off a bounce has nothing to key on;
 *   - forward sync resuming after an outage brings in mail that arrived hours
 *     earlier, so "synced now" is not "just arrived";
 *   - the provider may run its own responder, and Owlat cannot see it.
 *
 * A mailbox never changes kind (a move onto hosted mail provisions a new
 * mailbox), so a rule stored for a connected one stays inert. Saving or
 * switching one on is refused here; switching off and deleting stay open.
 */

import type { Doc } from '../_generated/dataModel';
import { throwInvalidState } from '../_utils/errors';

/** Whether Owlat receives this mailbox's mail itself, so its delivery rules run. */
export function runsDeliveryRules(mailbox: Pick<Doc<'mailboxes'>, 'kind'>): boolean {
	return mailbox.kind !== 'external';
}

export function assertRunsDeliveryRules(mailbox: Pick<Doc<'mailboxes'>, 'kind' | 'address'>): void {
	if (runsDeliveryRules(mailbox)) return;
	throwInvalidState(
		`${mailbox.address} is synced from its provider, so Owlat cannot forward its mail or reply to it automatically. Set this up at the provider.`
	);
}
