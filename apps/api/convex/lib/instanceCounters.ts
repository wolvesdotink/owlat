/**
 * The one read helper and the one write path for `instanceCounters` rows
 * (plan 2.4).
 *
 * The contact count, inbox counters, send counters, MTA health snapshot and
 * delivery-test stamp used to sit on the `instanceSettings` singleton, which
 * every feature gate reads, so each of their writes re-ran every gated query.
 * Each family now has its own row keyed by `key`, which also keeps one
 * family's writes from re-running another family's readers.
 *
 * Widen, migrate, narrow. A reader gets the row's fields when the row exists,
 * and the deprecated `instanceSettings` columns before that. A writer patches
 * the row, or creates it from those columns plus its patch, so a counter
 * carries on from the old value. The deprecated columns are no longer written;
 * `migrations/0046_split_hot_rows` creates any row still missing.
 *
 * Leaf module: it imports only types plus the `instanceSettings` leaf helper.
 */

import type { DatabaseReader, MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { getInstanceSettings } from './instanceSettings';

type CounterRow = Doc<'instanceCounters'>;
export type InstanceCounterKey = CounterRow['key'];
type CounterField = Exclude<keyof CounterRow, '_id' | '_creationTime' | 'key' | 'updatedAt'>;

/**
 * The fields each row owns; also the deprecated columns it is seeded from. A
 * family added after the split (`imapLegacy`) has no deprecated column and
 * starts empty.
 */
export const INSTANCE_COUNTER_FIELDS = {
	contacts: ['contactCount'],
	inbox: ['inboxStats', 'openThreads'],
	sends: ['transactionalSendCount', 'dailySendCount', 'dailySendCountResetAt'],
	mtaHealth: ['mtaHealth'],
	deliveryTest: ['deliveryTestLastSucceededAt'],
	imapLegacy: ['legacyImapSeenAt'],
} as const satisfies Record<InstanceCounterKey, readonly CounterField[]>;

export type InstanceCounterFields<K extends InstanceCounterKey> = Pick<
	CounterRow,
	(typeof INSTANCE_COUNTER_FIELDS)[K][number]
>;

function pickFields<K extends InstanceCounterKey>(
	key: K,
	source: CounterRow | Doc<'instanceSettings'> | null
): InstanceCounterFields<K> {
	const fields: Record<string, unknown> = {};
	for (const field of INSTANCE_COUNTER_FIELDS[key]) {
		const value = source ? (source as Record<string, unknown>)[field] : undefined;
		if (value !== undefined) fields[field] = value;
	}
	return fields as InstanceCounterFields<K>;
}

async function getRow(db: DatabaseReader, key: InstanceCounterKey): Promise<CounterRow | null> {
	return await db
		.query('instanceCounters')
		.withIndex('by_key', (q) => q.eq('key', key))
		.first(); // bounded: one row per key
}

/** The current values of `key`'s fields (row first, deprecated columns before backfill). */
export async function readInstanceCounter<K extends InstanceCounterKey>(
	db: DatabaseReader,
	key: K
): Promise<InstanceCounterFields<K>> {
	const row = await getRow(db, key);
	return pickFields(key, row ?? (await getInstanceSettings(db)));
}

/**
 * Write `patch` onto `key`'s row, creating it from the deprecated columns when
 * absent. Never touches `instanceSettings`.
 */
export async function writeInstanceCounter<K extends InstanceCounterKey>(
	ctx: MutationCtx,
	key: K,
	patch: InstanceCounterFields<K>,
	now: number = Date.now()
): Promise<void> {
	const row = await getRow(ctx.db, key);
	if (row) {
		await ctx.db.patch(row._id, { ...patch, updatedAt: now });
		return;
	}
	await ctx.db.insert('instanceCounters', {
		key,
		...pickFields(key, await getInstanceSettings(ctx.db)),
		...patch,
		updatedAt: now,
	});
}

/**
 * Create `key`'s row from the deprecated columns when it does not exist yet.
 * Idempotent; used by the backfill migration. Returns whether it created one.
 * A key with nothing to carry over still gets a (field-less) row, which reads
 * exactly like the absent columns did, so readers stop consulting
 * `instanceSettings` once the backfill has run.
 */
export async function ensureInstanceCounter(
	ctx: MutationCtx,
	key: InstanceCounterKey
): Promise<boolean> {
	if (await getRow(ctx.db, key)) return false;
	await ctx.db.insert('instanceCounters', {
		key,
		...pickFields(key, await getInstanceSettings(ctx.db)),
		updatedAt: Date.now(),
	});
	return true;
}
