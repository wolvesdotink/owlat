/**
 * Pure logic for the default (non-migration) fresh-start onboarding path.
 *
 * Kept framework-free so the decision the flow hinges on is unit-testable
 * without a Convex client or a mounted component: what the Postbox mailbox guard
 * should show for a member with no open mailbox.
 */

/**
 * What a member with no open Postbox mailbox can do, in priority order:
 *   - `loading`          — still resolving; show a spinner, decide nothing.
 *   - `ready`            — a live mailbox exists; render the page.
 *   - `reserved`         — a hosted mailbox is reserved for them but unclaimed;
 *                          offer to claim it.
 *   - `external-allowed` — no mailbox, but connecting an external account is
 *                          enabled; offer that.
 *   - `dead-end`         — nothing they can do alone; offer to ask an admin.
 */
export type MailboxGuardState = 'loading' | 'ready' | 'reserved' | 'external-allowed' | 'dead-end';

export interface MailboxGuardInput {
	/** The status query is still resolving. */
	loading: boolean;
	/** A live personal mailbox already exists. */
	hasMailbox: boolean;
	/** Address of an unclaimed hosted reservation for this member, if any. */
	reservedAddress: string | null;
	/** Connecting an external IMAP/SMTP account is enabled on this instance. */
	externalAllowed: boolean;
}

/**
 * Collapse the raw mailbox signals into the single guard state the UI renders.
 * A live mailbox always wins; then an unclaimed reservation; then the external
 * escape hatch; and only when none apply is the member at an honest dead-end.
 */
export function deriveMailboxGuardState(input: MailboxGuardInput): MailboxGuardState {
	if (input.loading) return 'loading';
	if (input.hasMailbox) return 'ready';
	if (input.reservedAddress) return 'reserved';
	if (input.externalAllowed) return 'external-allowed';
	return 'dead-end';
}
