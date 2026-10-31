/**
 * The shapes of the derived-field registry (`./registry.ts`).
 *
 * A DERIVED field (`// AGGREGATED [<id>] —` in the schema) is a cache of what
 * other rows already record: a count of a room's messages, the sum of a
 * campaign's stat shards. Its entry says how to recompute it for one parent row
 * from those rows, and the sampler (`./sampler.ts`) uses that to find and repair
 * drift.
 *
 * A COUNTER field (`// COUNTER [<id>] —`) is the only record of the events it
 * counts: nothing else stores each saved-reply use or each SMTP response, so
 * there is nothing to recompute it from. Its entry says why, so that the
 * decision is made once, in one place, and the source guard can tell the two
 * labels apart.
 */

import type { Doc, TableNames } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { estimateDocumentBytes } from '../../contacts/erasure/budget';

/**
 * Field values compared by the sampler, keyed by schema path (`messageCount`,
 * `outbound.state`). Values are the field as readers interpret it: an optional
 * counter that reads as 0 when absent is reported as 0, so an absent value and
 * a zero never count as drift.
 */
export type DerivedValues = Record<string, string | number | undefined>;

/** Why a recount gave no answer. None of them is drift; nothing is written. */
export type RecountSkipReason =
	/** The parent has more source rows than one transaction may read. */
	| 'over_budget'
	/** The source is incomplete for this parent (aged out, or not rebuilt yet). */
	| 'unverifiable';

export type RecountResult =
	| { status: 'counted'; expected: DerivedValues }
	| { status: 'skipped'; reason: RecountSkipReason };

/**
 * How a detected difference is handled.
 *   - `exact`: the source is complete, so the cache is set to the recount.
 *   - `raise_only`: the source is a lower bound (a lifetime total whose rows
 *     may have been removed), so the cache is only ever raised to the recount;
 *     a cache above it is logged and left alone.
 */
export type RepairPolicy = 'exact' | 'raise_only';

interface RegistryEntryBase<T extends TableNames> {
	/** Stable id, also the `[id]` the schema annotation carries. */
	readonly id: string;
	readonly table: T;
	/** Schema paths under `table` this entry covers (`outbound.state` for a nested field). */
	readonly fields: readonly string[];
	/**
	 * Name of the shared validator spread the annotation sits on, when the
	 * fields are declared through one (`...campaignShardedStatFields`).
	 */
	readonly spread?: string;
}

export interface DerivedFieldEntry<T extends TableNames = TableNames> extends RegistryEntryBase<T> {
	readonly kind: 'derived';
	/** The rows the field is recomputed from, for the drift log and the docs. */
	readonly source: string;
	readonly policy: RepairPolicy;
	/**
	 * Parents the sampler leaves alone: soft-deleted rows (frozen while they
	 * wait), rows whose cache another job keeps fresh on its own cadence.
	 * Defaults to "not soft-deleted".
	 */
	readonly isEligible?: (parent: Doc<T>, now: number) => boolean;
	/** The cached values, as readers interpret them. */
	readonly current: (parent: Doc<T>) => DerivedValues;
	/** Recount `parent` from its source, within `budget`. Reads only. */
	readonly recompute: (
		ctx: MutationCtx,
		parent: Doc<T>,
		budget: RecountBudget
	) => Promise<RecountResult>;
	/**
	 * Write the recount back. Defaults to patching the drifted top-level fields;
	 * an entry with nested paths or a freshness stamp supplies its own.
	 */
	readonly repair?: (
		ctx: MutationCtx,
		parent: Doc<T>,
		expected: DerivedValues,
		now: number
	) => Promise<void>;
}

export interface CounterFieldEntry<T extends TableNames = TableNames> extends RegistryEntryBase<T> {
	readonly kind: 'counter';
	/** Why the field cannot be recomputed: what would have to exist for it to be. */
	readonly why: string;
}

export type RegistryEntry = DerivedFieldEntry | CounterFieldEntry;

/** Erase the table parameter so entries of different tables share one list. */
export function derived<T extends TableNames>(entry: DerivedFieldEntry<T>): DerivedFieldEntry {
	return entry as unknown as DerivedFieldEntry;
}

export function counter<T extends TableNames>(entry: CounterFieldEntry<T>): CounterFieldEntry {
	return entry as unknown as CounterFieldEntry;
}

/** Source rows one recount may read. */
export const RECOUNT_ROW_BUDGET = 4_000;

/**
 * Bytes one recount may read. Convex fetches an iterated range in batches, so
 * the platform limit has to sit well above this for the batch that crosses it.
 */
export const RECOUNT_BYTE_BUDGET = 4 * 1024 * 1024;

/**
 * The allowance of one recount. A recount that runs out gives up (`over_budget`)
 * rather than writing a partial count: a parent too large for one transaction
 * is logged and left to its own writers.
 */
export class RecountBudget {
	private rowsRead = 0;
	private bytesRead = 0;

	constructor(
		private readonly maxRows: number = RECOUNT_ROW_BUDGET,
		private readonly maxBytes: number = RECOUNT_BYTE_BUDGET
	) {}

	get rows(): number {
		return this.rowsRead;
	}

	/** Account for one source row. False once either allowance is exceeded. */
	charge(doc: unknown): boolean {
		this.rowsRead += 1;
		this.bytesRead += estimateDocumentBytes(doc);
		return this.rowsRead <= this.maxRows && this.bytesRead <= this.maxBytes;
	}
}

/**
 * Visit every row of `rows` within `budget`. False when the budget ran out
 * first, in which case the caller must not use what it accumulated.
 */
export async function recountWithin<D>(
	rows: AsyncIterable<D>,
	budget: RecountBudget,
	visit: (row: D) => void
): Promise<boolean> {
	for await (const row of rows) {
		if (!budget.charge(row)) return false;
		visit(row);
	}
	return true;
}
