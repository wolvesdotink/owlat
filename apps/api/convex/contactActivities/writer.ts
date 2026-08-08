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
import { ENGAGEMENT_ACTIVITY_LITERALS } from '../analytics/engagementActivity';
import { engagementPatchForActivity } from '../analytics/engagementScoreSync';

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

type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _assert: AssertEqual<keyof typeof ACTIVITY_MODULES, ContactActivityType> = true;
void _assert;

export type ActivityModuleMap = typeof ACTIVITY_MODULES;

/**
 * Activity literals that trigger the single post-insert contact patch: the
 * shipped `hasOpened`/`hasClicked` booleans plus the engagement-score
 * accumulator (deliverability plan P0-2). Every other literal skips the contact
 * read entirely, exactly as before.
 *
 * DERIVED, never re-listed: the set comes straight from the scoring adapter's
 * mapping table (`analytics/engagementActivity.ts`), so a literal added there
 * cannot silently fail to reach the hot path. `hasOpened`/`hasClicked` are a
 * strict subset of it, so one gate covers both denormalizations.
 */
const ENGAGEMENT_DENORMALIZED_LITERALS: ReadonlySet<ContactActivityType> =
	ENGAGEMENT_ACTIVITY_LITERALS;

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
	}
): Promise<Id<'contactActivities'>> {
	const occurredAt = args.occurredAt ?? Date.now();
	const activityId = await ctx.db.insert('contactActivities', {
		contactId: args.contactId,
		activityType: args.literal,
		metadata: args.metadata as Doc<'contactActivities'>['metadata'],
		occurredAt,
	});

	// Denormalize email open/click engagement onto the contact row so segment +
	// automation `email_activity` conditions read an O(1) boolean off the
	// already-loaded contact instead of scanning the unbounded contactActivities
	// table. The `hasOpened`/`hasClicked` half is monotonic (open/click never
	// un-happens), so it only ever sets true, and only when not already set.
	//
	// The same contact read also feeds the engagement score's INCREMENTAL update
	// (deliverability plan P0-2): folding the new activity into the cached decayed
	// accumulator is O(1) — no activity-timeline read on this path — and both
	// denormalizations land in ONE patch.
	//
	// WRITE COST, STATED PLAINLY. This used to be ~0 contact writes per open
	// after the first (the flag was already set, so nothing was patched). It is
	// now EXACTLY ONE contact write for every open, click, bounce, complaint and
	// reply — the five literals in ENGAGEMENT_DENORMALIZED_LITERALS — on the
	// hottest write path in the product. That is accepted because the score has
	// to decay against the accumulator's as-of instant, and an accumulator whose
	// stamp did not advance is not a cheaper write, it is a wrong one. The cost
	// is bounded: it is a patch of a PER-CONTACT row (never a shared document, so
	// writes spread across contacts and there is no OCC hotspot), it touches only
	// the engagement fields, it leaves `updatedAt` alone so nothing downstream
	// sees the contact as edited, and it is still ONE write per activity — the
	// insert above already made this transaction a write transaction.
	if (ENGAGEMENT_DENORMALIZED_LITERALS.has(args.literal)) {
		const contact = await ctx.db.get(args.contactId);
		if (contact) {
			const flags =
				args.literal === 'email_opened' && contact.hasOpened !== true
					? { hasOpened: true }
					: args.literal === 'email_clicked' && contact.hasClicked !== true
						? { hasClicked: true }
						: undefined;

			// Widen to the documented per-literal union — the same correlated-union
			// cast this module already sanctions for its callers — and then narrow
			// on the literal for real. The metadata shape is never asserted; it is
			// read from the union member the discriminant selects.
			const narrowed = args as RecordContactActivityArgs;
			const bounceType =
				narrowed.literal === 'email_bounced' ? narrowed.metadata.bounceType : undefined;

			const engagement = engagementPatchForActivity({
				contact,
				activityType: args.literal,
				occurredAt,
				bounceType,
				now: Date.now(),
			});

			if (flags !== undefined || engagement !== null) {
				await ctx.db.patch(args.contactId, { ...flags, ...engagement });
			}
		}
	}

	return activityId;
}
