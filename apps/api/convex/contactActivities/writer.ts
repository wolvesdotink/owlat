/**
 * Contact activity writer-side dispatch + single writer.
 *
 * The `ACTIVITY_MODULES` map is the dispatch table — keyed by
 * `ContactActivityType` literal, valued by each per-literal module's
 * writer half. `recordContactActivity` is the only place that inserts
 * into the `contactActivities` table; the per-literal `MetadataFor<L>`
 * type narrows the `metadata` arg at every call site.
 *
 * Lifecycle modules emit a single `contact_activity` effect kind
 * carrying `{ literal, contactId, metadata }`; the effect runner calls
 * this writer. Non-lifecycle inline writers (e.g.
 * `inbox/messages.ts:receiveMessage`) call it directly.
 *
 * See CONTEXT.md `Contact activity (module)` for the full contract.
 */

import type { Infer } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';

import type { ContactActivityType } from './catalog';

import { emailSent } from './email_sent';
import { emailOpened } from './email_opened';
import { emailClicked } from './email_clicked';
import { emailBounced } from './email_bounced';
import { emailComplained } from './email_complained';
import { topicSubscribed } from './topic_subscribed';
import { topicUnsubscribed } from './topic_unsubscribed';
import { topicConfirmed } from './topic_confirmed';
import { doiAttested } from './doi_attested';
import { propertyUpdated } from './property_updated';
import { created } from './created';
import { inboundReceived } from './inbound_received';
import { inboundReplied } from './inbound_replied';

export const ACTIVITY_MODULES = {
	email_sent: emailSent,
	email_opened: emailOpened,
	email_clicked: emailClicked,
	email_bounced: emailBounced,
	email_complained: emailComplained,
	topic_subscribed: topicSubscribed,
	topic_unsubscribed: topicUnsubscribed,
	topic_confirmed: topicConfirmed,
	doi_attested: doiAttested,
	property_updated: propertyUpdated,
	created,
	inbound_received: inboundReceived,
	inbound_replied: inboundReplied,
} as const;

// ─── Compile-time: ACTIVITY_MODULES keys ≡ ContactActivityType ──────────────
// If a new literal is added to the catalog without a matching module entry
// here (or vice versa), this stops compiling.

type AssertEqual<A, B> =
	[A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _assert: AssertEqual<keyof typeof ACTIVITY_MODULES, ContactActivityType> = true;
void _assert;

export type ActivityModuleMap = typeof ACTIVITY_MODULES;

/** Metadata shape for a given activity literal (derived from the module's schema). */
export type MetadataFor<L extends ContactActivityType> = Infer<
	ActivityModuleMap[L]['metadataSchema']
>;

/**
 * Args for `recordContactActivity`. Inline callers use the generic form
 * with a string-literal `literal` — TS narrows `metadata` to
 * `MetadataFor<L>` from the literal. Lifecycle effect runners that
 * forward a `contact_activity` effect through this writer need to cast
 * to `RecordContactActivityArgs` at the call site (the correlated-unions
 * limitation in TS doesn't preserve the literal ↔ metadata pairing once
 * the effect is destructured), but the source-side effect type already
 * encodes the correlation so the cast is safe.
 */
export type RecordContactActivityArgs = {
	[L in ContactActivityType]: {
		literal: L;
		contactId: Id<'contacts'>;
		metadata: MetadataFor<L>;
		occurredAt?: number;
	};
}[ContactActivityType];

/**
 * Single internal writer for `contactActivities`. The only place that
 * inserts into the table.
 *
 * Compile-time typed per-literal via `MetadataFor<L>` — inline callers
 * pass a string-literal `literal` and get full inference; lifecycle
 * effect runners cast through `RecordContactActivityArgs`. `occurredAt`
 * defaults to `Date.now()`.
 */
export async function recordContactActivity<L extends ContactActivityType>(
	ctx: MutationCtx,
	args: {
		literal: L;
		contactId: Id<'contacts'>;
		metadata: MetadataFor<L>;
		occurredAt?: number;
	},
): Promise<Id<'contactActivities'>> {
	const activityId = await ctx.db.insert('contactActivities', {
		contactId: args.contactId,
		activityType: args.literal,
		metadata: args.metadata as Doc<'contactActivities'>['metadata'],
		occurredAt: args.occurredAt ?? Date.now(),
	});

	// Denormalize email open/click engagement onto the contact row so segment +
	// automation `email_activity` conditions read an O(1) boolean off the
	// already-loaded contact instead of scanning the unbounded contactActivities
	// table. Monotonic (open/click never un-happens), so we only ever set true,
	// and only when not already set — the per-contact patch is idempotent and
	// skipped on the common (already-engaged) case. Patches the contact row, not
	// a shared document, so writes spread across contacts (no OCC hotspot).
	if (args.literal === 'email_opened' || args.literal === 'email_clicked') {
		const contact = await ctx.db.get(args.contactId);
		if (contact) {
			if (args.literal === 'email_opened' && contact.hasOpened !== true) {
				await ctx.db.patch(args.contactId, { hasOpened: true });
			} else if (args.literal === 'email_clicked' && contact.hasClicked !== true) {
				await ctx.db.patch(args.contactId, { hasClicked: true });
			}
		}
	}

	return activityId;
}
