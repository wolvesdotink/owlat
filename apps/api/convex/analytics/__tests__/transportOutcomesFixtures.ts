/**
 * Shared fixtures for the `transportOutcomes` suite.
 *
 * Every file in the suite needs the same three things: a campaign send that
 * HAS an assignment row (so the outcome recorder can learn its cell and arm), a
 * way to read back the sharded buckets, and the singleton-org id the recorder
 * resolves. Extracted here so the five test files assert different things
 * instead of re-declaring the same scaffolding five times.
 */

import type { DatabaseReader, DatabaseWriter } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
} from '../../__tests__/factories';
import { deliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import type {
	TransportOutcomeArm,
	TransportOutcomeBucket,
	TransportOutcomeTotals,
} from '../transportOutcomeSummary';
import { ZERO_TRANSPORT_OUTCOME_TOTALS } from '../transportOutcomeSummary';

/** The org `getSingletonOrganizationId` is mocked to return in this suite. */
export const OUTCOME_ORG = 'org_outcomes';

/** A second tenant, used only to prove reads and joins never cross tenants. */
export const OTHER_ORG = 'org_other';

/** Real, branded cell keys — built through the shared constructor, never typed
 * out as strings, so a rename of the key format breaks the suite loudly. */
export const GMAIL_CAMPAIGN_CELL = deliverabilityCellKey({
	stream: 'campaign',
	destinationProvider: 'gmail',
});
export const MICROSOFT_CAMPAIGN_CELL = deliverabilityCellKey({
	stream: 'campaign',
	destinationProvider: 'microsoft',
});

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface SeededSend {
	readonly sendId: Id<'emailSends'>;
	readonly campaignId: Id<'campaigns'>;
	readonly contactId: Id<'contacts'>;
	readonly email: string;
}

export interface SeedSendOptions {
	readonly status?: Doc<'emailSends'>['status'];
	/**
	 * Reuse an existing contact instead of minting one — for a case that seeds a
	 * contact SEVERAL sends and cares which one a join picks.
	 */
	readonly contactId?: Id<'contacts'>;
	/**
	 * The dispatch stamp. Set it where a case seeds one contact several sends
	 * whose DISPATCH order differs from their creation order — the real shape of a
	 * pre-created blast audience, and the only way to hold an attribution join to
	 * ordering by dispatch rather than by row age.
	 */
	readonly sentAt?: number;
	/** Omit to seed a send with NO assignment row (the seed-probe seam). */
	readonly assignment?: {
		readonly organizationId?: string;
		readonly cell?: string;
		readonly arm?: TransportOutcomeArm;
		readonly isCalibration?: boolean;
	};
	readonly providerMessageId?: string;
}

/**
 * A campaign send plus (optionally) the `sendAssignments` row the outcome
 * recorder joins through. `providerType: 'mta'` matches the `own` arm the
 * assignment records by default.
 */
export async function seedAssignedSend(
	ctx: { db: DatabaseWriter },
	options: SeedSendOptions = {}
): Promise<SeededSend> {
	const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
	const existing = options.contactId ? await ctx.db.get(options.contactId) : null;
	const contact = existing ?? createTestContact();
	const contactId = existing?._id ?? (await ctx.db.insert('contacts', contact));
	// `contactEmail` is the send's SNAPSHOT of the contact it is joined to, so it
	// may not be invented here: a reused contact carrying no email is a broken
	// seed, not a send to some made-up address a later assertion could be written
	// against. The factory always sets one.
	const email = contact.email;
	if (email === undefined) throw new Error('seedAssignedSend: reused contact has no email');
	const sendId = await ctx.db.insert(
		'emailSends',
		createTestEmailSend({
			campaignId,
			contactId,
			contactEmail: email,
			status: options.status ?? 'queued',
			providerType: 'mta',
			...(options.sentAt !== undefined ? { sentAt: options.sentAt } : {}),
			...(options.providerMessageId !== undefined
				? { providerMessageId: options.providerMessageId }
				: {}),
		})
	);

	if (options.assignment) {
		await ctx.db.insert('sendAssignments', {
			organizationId: options.assignment.organizationId ?? OUTCOME_ORG,
			sendId,
			sendKind: 'campaign',
			cell: options.assignment.cell ?? GMAIL_CAMPAIGN_CELL,
			transport: options.assignment.arm === 'reference' ? 'ses' : 'mta',
			arm: options.assignment.arm ?? 'own',
			isCalibration: options.assignment.isCalibration ?? false,
			mixVersion: 0,
			assignedAt: Date.now(),
		});
	}

	return { sendId, campaignId, contactId, email };
}

/**
 * A transactional `test` PREVIEW send plus its assignment row.
 *
 * Test previews keep the durable lifecycle (routing re-entry needs it) but must
 * never become telemetry: `withoutTestSendEffects` blanks the whole effect
 * array, which is what keeps a preview out of the arm denominators. Seeding one
 * WITH an assignment row is the only way to prove that exclusion still holds —
 * the recorder would otherwise decline it for the unrelated reason that it has
 * no assignment.
 */
export async function seedAssignedTestPreview(
	ctx: { db: DatabaseWriter },
	options: { readonly status?: Doc<'transactionalSends'>['status'] } = {}
): Promise<Id<'transactionalSends'>> {
	const sendId = await ctx.db.insert('transactionalSends', {
		kind: 'test',
		email: 'preview@example.com',
		status: options.status ?? 'queued',
		queuedAt: Date.now(),
		providerType: 'mta',
	});
	await ctx.db.insert('sendAssignments', {
		organizationId: OUTCOME_ORG,
		sendId,
		sendKind: 'transactional',
		cell: GMAIL_CAMPAIGN_CELL,
		transport: 'mta',
		arm: 'own',
		isCalibration: false,
		mixVersion: 0,
		assignedAt: Date.now(),
	});
	return sendId;
}

/** Every shard row of one (org, cell, arm) — the writer's whole footprint. */
export async function readBuckets(
	ctx: { db: DatabaseReader },
	input: { organizationId?: string; cell?: string; arm?: TransportOutcomeArm } = {}
): Promise<TransportOutcomeBucket[]> {
	const rows = await ctx.db.query('transportOutcomes').collect();
	return rows.filter(
		(row) =>
			(input.organizationId === undefined || row.organizationId === input.organizationId) &&
			(input.cell === undefined || row.cell === input.cell) &&
			(input.arm === undefined || row.arm === input.arm)
	);
}

/**
 * Every counter of one bucket, as a plain object shaped like
 * `TransportOutcomeTotals`.
 *
 * Assert the WHOLE object per case (`{ ...ZERO_TRANSPORT_OUTCOME_TOTALS,
 * delivered: 1 }`) rather than the one counter the case is named after: an
 * outcome landing on the wrong counter, or failing to land at all, has to fail
 * the test. A matrix that only checked the counter under test is exactly how a
 * missing `delivered` bump once survived this suite.
 *
 * Use this ONLY where exactly one write is expected. A case that produces two
 * outcome writes draws two INDEPENDENT shard keys, so reading a single row is a
 * 1-in-`TRANSPORT_OUTCOME_SHARD_COUNT` coin flip — use `sumCounters` there.
 */
export function pickCounters(bucket: TransportOutcomeBucket | undefined): TransportOutcomeTotals {
	if (!bucket) throw new Error('no bucket to read counters from');
	return {
		sent: bucket.sent,
		delivered: bucket.delivered,
		deferred: bucket.deferred,
		softBounced: bucket.softBounced,
		hardBounced: bucket.hardBounced,
		complained: bucket.complained,
		opened: bucket.opened,
		clicked: bucket.clicked,
		unsubscribed: bucket.unsubscribed,
		calibrationSent: bucket.calibrationSent,
		calibrationOpened: bucket.calibrationOpened,
		calibrationClicked: bucket.calibrationClicked,
	};
}

/** Sum one counter across every shard row returned. */
export function sumCounter(
	buckets: readonly TransportOutcomeBucket[],
	counter: keyof Pick<
		TransportOutcomeBucket,
		| 'sent'
		| 'delivered'
		| 'deferred'
		| 'softBounced'
		| 'hardBounced'
		| 'complained'
		| 'opened'
		| 'clicked'
		| 'unsubscribed'
		| 'calibrationSent'
		| 'calibrationOpened'
		| 'calibrationClicked'
	>
): number {
	return buckets.reduce((total, bucket) => total + bucket[counter], 0);
}

/**
 * Every counter summed across every shard row handed in — the shard-blind
 * equivalent of `pickCounters`, and the DEFAULT helper for the transition
 * matrix.
 *
 * The shard key is drawn per WRITE, so a lifecycle transition that produces two
 * outcome writes (an open that is also the first delivery evidence, say) lands
 * on one row only by luck. Summing makes the assertion a statement about the
 * bucket rather than about the random draw, and folding over the keys of
 * `ZERO_TRANSPORT_OUTCOME_TOTALS` means a new counter column cannot be
 * forgotten here.
 */
export function sumCounters(buckets: readonly TransportOutcomeBucket[]): TransportOutcomeTotals {
	const totals: { -readonly [K in keyof TransportOutcomeTotals]: number } = {
		...ZERO_TRANSPORT_OUTCOME_TOTALS,
	};
	for (const counter of Object.keys(totals) as (keyof TransportOutcomeTotals)[]) {
		totals[counter] = sumCounter(buckets, counter);
	}
	return totals;
}

/**
 * The distinct `(organizationId, cell, arm, periodStart)` keys the rows carry.
 *
 * A matrix case asserts `toHaveLength(1)` on this rather than on the row count:
 * "one bucket" is a claim about the key, and the shard split underneath it is
 * deliberately invisible to readers.
 */
export function uniqueBucketKeys(buckets: readonly TransportOutcomeBucket[]): string[] {
	return [
		...new Set(
			buckets.map(
				(bucket) => `${bucket.organizationId}|${bucket.cell}|${bucket.arm}|${bucket.periodStart}`
			)
		),
	];
}

/** A zeroed bucket row, for tests that write buckets directly. */
export function bucketRow(overrides: {
	organizationId?: string;
	cell?: string;
	arm?: TransportOutcomeArm;
	periodStart: number;
	shardKey: number;
	sent?: number;
	delivered?: number;
	deferred?: number;
	softBounced?: number;
	hardBounced?: number;
	complained?: number;
	opened?: number;
	clicked?: number;
	unsubscribed?: number;
	calibrationSent?: number;
	calibrationOpened?: number;
	calibrationClicked?: number;
}): Omit<TransportOutcomeBucket, '_id' | '_creationTime'> {
	return {
		organizationId: overrides.organizationId ?? OUTCOME_ORG,
		cell: overrides.cell ?? GMAIL_CAMPAIGN_CELL,
		arm: overrides.arm ?? 'own',
		periodStart: overrides.periodStart,
		shardKey: overrides.shardKey,
		sent: overrides.sent ?? 0,
		delivered: overrides.delivered ?? 0,
		deferred: overrides.deferred ?? 0,
		softBounced: overrides.softBounced ?? 0,
		hardBounced: overrides.hardBounced ?? 0,
		complained: overrides.complained ?? 0,
		opened: overrides.opened ?? 0,
		clicked: overrides.clicked ?? 0,
		unsubscribed: overrides.unsubscribed ?? 0,
		calibrationSent: overrides.calibrationSent ?? 0,
		calibrationOpened: overrides.calibrationOpened ?? 0,
		calibrationClicked: overrides.calibrationClicked ?? 0,
		lastRecordedAt: overrides.periodStart,
	};
}
