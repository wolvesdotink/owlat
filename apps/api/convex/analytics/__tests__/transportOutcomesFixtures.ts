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
import type { TransportOutcomeArm, TransportOutcomeBucket } from '../transportOutcomeSummary';

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
	const contact = createTestContact();
	const contactId = await ctx.db.insert('contacts', contact);
	const email = contact.email;
	const sendId = await ctx.db.insert(
		'emailSends',
		createTestEmailSend({
			campaignId,
			contactId,
			contactEmail: email,
			status: options.status ?? 'queued',
			providerType: 'mta',
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
