/**
 * How a sender is named by the Senders calls (SPEC §5): by
 * `{mailboxId, senderDigest}` (the Senders page) or by a message from it (the
 * reader's ⇧E / ⇧O and chip, the Subscriptions panel).
 *
 * A leaf: shared by the mutations (`./status.ts`) and the Node action
 * (`./unsubscribeActions.ts`) without pulling one runtime into the other.
 */

import { v, type Infer } from 'convex/values';

export const senderTargetValidator = v.union(
	v.object({ mailboxId: v.id('mailboxes'), senderDigest: v.string() }),
	v.object({ messageId: v.id('mailMessages') })
);

export type SenderTarget = Infer<typeof senderTargetValidator>;
