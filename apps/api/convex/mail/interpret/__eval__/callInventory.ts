/**
 * The call inventory: provider requests and cost per message, by path and by
 * task, derived from ledger rows grouped by their root request (AI routing plan
 * Phase 1a; Phase 1c's acceptance is "calls per message by path and kind drop
 * against the baseline").
 *
 * The input is rows in the ledger's own field names (`llmUsageEvents`, plus
 * the Phase 1a columns `rootRequestId`, `task`, `attempt`, …), so the same code
 * reads three sources: the rows an eval run records (`decisionRunner.ts`), an
 * exported ledger (`apps/api/scripts/ai-baseline-eval.ts --ledger`), and test
 * fixtures.
 *
 * Counting rules:
 *   - one row is one provider request; a retry is a row with `attempt > 1`;
 *   - a logical call is one `requestId` (a row without one counts alone);
 *   - a root is one message's run (or one user action), keyed `rootRequestId`;
 *     rows without it are reported as unattributed, never guessed into a root;
 *   - a message that cost no call writes no row. Pass the number of messages a
 *     path processed (`messageCounts`) or the per-message figures describe only
 *     messages that reached a model, and a change that skips every call for
 *     some messages would read as no change at all.
 *
 * Pure and isolate-safe.
 */
import { mean, quantile } from './stats';

/** The ledger fields the inventory reads: a structural subset of an `llmUsageEvents` row. */
export interface LedgerCallRow {
	feature: string;
	plane?: 'language' | 'embedding' | 'decision';
	modelUsed?: string;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	costUsd: number;
	requestId?: string;
	rootRequestId?: string;
	parentCallId?: string;
	task?: string;
	attempt?: number;
	endpoint?: string;
	latencyMs?: number;
	isEstimated?: boolean;
	isFallback?: boolean;
}

export interface Spread {
	mean: number | null;
	p50: number | null;
	p95: number | null;
	max: number | null;
}

export interface TaskInventory {
	requests: number;
	logicalCalls: number;
	retries: number;
	costUsd: number;
	/** Requests of this task per processed message on the path. */
	requestsPerMessage: number | null;
	costPerMessage: number | null;
}

export interface PathInventory {
	path: string;
	/** Roots that wrote at least one row. */
	roots: number;
	/** Messages the path processed: `messageCounts[path]`, never fewer than `roots`. */
	messages: number;
	/** True when no message count was given, so zero-call messages are missing. */
	isRootsOnly: boolean;
	requests: number;
	logicalCalls: number;
	retries: number;
	fallbacks: number;
	costUsd: number;
	/** The part of `costUsd` on rows marked `isEstimated`. */
	estimatedCostUsd: number;
	requestsPerMessage: Spread;
	costPerMessage: Spread;
	byTask: Record<string, TaskInventory>;
}

export interface CallInventory {
	rows: number;
	unattributedRows: number;
	unattributedCostUsd: number;
	paths: PathInventory[];
}

export interface CallInventoryOptions {
	/** The path a root belongs to. Default {@link defaultPathOf}. */
	pathOf?: (rootRequestId: string, rows: readonly LedgerCallRow[]) => string;
	/** The task a row counts under. Default: `task`, else `feature:<feature>`. */
	taskOf?: (row: LedgerCallRow) => string;
	/** Messages processed per path, zero-call messages included. */
	messageCounts?: Readonly<Record<string, number>>;
}

/** Ledger `feature` prefixes → path, for rows whose root id carries no path. */
const FEATURE_PATHS: readonly [string, string][] = [
	['agent_', 'team'],
	['team_', 'team'],
	['postbox_', 'postbox'],
	['interpret', 'postbox'],
	['knowledge_', 'knowledge'],
	['assistant_', 'assistant'],
	['chat_assistant', 'assistant'],
];

/**
 * A root id of the form `<path>:<id>` names its path. Otherwise the first row
 * whose feature has a known prefix decides, and anything else is `other`.
 */
export function defaultPathOf(rootRequestId: string, rows: readonly LedgerCallRow[]): string {
	const colon = rootRequestId.indexOf(':');
	if (colon > 0) return rootRequestId.slice(0, colon);
	for (const row of rows) {
		const match = FEATURE_PATHS.find(([prefix]) => row.feature.startsWith(prefix));
		if (match) return match[1];
	}
	return 'other';
}

const defaultTaskOf = (row: LedgerCallRow) => row.task ?? `feature:${row.feature}`;

function spread(values: readonly number[]): Spread {
	return {
		mean: mean(values),
		p50: quantile(values, 0.5),
		p95: quantile(values, 0.95),
		max: values.length === 0 ? null : Math.max(...values),
	};
}

function logicalCalls(rows: readonly LedgerCallRow[]): number {
	const ids = new Set<string>();
	let anonymous = 0;
	for (const row of rows) {
		if (row.requestId === undefined) anonymous++;
		else ids.add(row.requestId);
	}
	return ids.size + anonymous;
}

const sumCost = (rows: readonly LedgerCallRow[]) => rows.reduce((sum, r) => sum + r.costUsd, 0);
const retries = (rows: readonly LedgerCallRow[]) => rows.filter((r) => (r.attempt ?? 1) > 1).length;

export function callInventory(
	rows: readonly LedgerCallRow[],
	options: CallInventoryOptions = {}
): CallInventory {
	const pathOf = options.pathOf ?? defaultPathOf;
	const taskOf = options.taskOf ?? defaultTaskOf;
	const roots = new Map<string, LedgerCallRow[]>();
	const unattributed: LedgerCallRow[] = [];
	for (const row of rows) {
		if (!row.rootRequestId) {
			unattributed.push(row);
			continue;
		}
		const list = roots.get(row.rootRequestId) ?? [];
		list.push(row);
		roots.set(row.rootRequestId, list);
	}

	const byPath = new Map<string, LedgerCallRow[][]>();
	for (const [root, list] of roots) {
		const path = pathOf(root, list);
		byPath.set(path, [...(byPath.get(path) ?? []), list]);
	}
	for (const path of Object.keys(options.messageCounts ?? {})) {
		if (!byPath.has(path)) byPath.set(path, []);
	}

	const paths: PathInventory[] = [];
	for (const [path, groups] of [...byPath].sort(([a], [b]) => a.localeCompare(b))) {
		const counted = options.messageCounts?.[path];
		const messages = Math.max(groups.length, counted ?? 0);
		const zeros = Array.from({ length: messages - groups.length }, () => 0);
		const all = groups.flat();
		const tasks = new Map<string, LedgerCallRow[]>();
		for (const row of all) {
			const task = taskOf(row);
			tasks.set(task, [...(tasks.get(task) ?? []), row]);
		}
		const byTask: Record<string, TaskInventory> = {};
		for (const [task, list] of [...tasks].sort(([a], [b]) => a.localeCompare(b))) {
			byTask[task] = {
				requests: list.length,
				logicalCalls: logicalCalls(list),
				retries: retries(list),
				costUsd: sumCost(list),
				requestsPerMessage: messages === 0 ? null : list.length / messages,
				costPerMessage: messages === 0 ? null : sumCost(list) / messages,
			};
		}
		paths.push({
			path,
			roots: groups.length,
			messages,
			isRootsOnly: counted === undefined,
			requests: all.length,
			logicalCalls: logicalCalls(all),
			retries: retries(all),
			fallbacks: all.filter((r) => r.isFallback).length,
			costUsd: sumCost(all),
			estimatedCostUsd: sumCost(all.filter((r) => r.isEstimated)),
			requestsPerMessage: spread([...groups.map((g) => g.length), ...zeros]),
			costPerMessage: spread([...groups.map(sumCost), ...zeros]),
			byTask,
		});
	}
	return {
		rows: rows.length,
		unattributedRows: unattributed.length,
		unattributedCostUsd: sumCost(unattributed),
		paths,
	};
}

/** Per-message change of one path (and its tasks) between two inventories. */
export interface InventoryDelta {
	path: string;
	task: string | null;
	requestsPerMessage: { before: number | null; after: number | null; change: number | null };
	costPerMessage: { before: number | null; after: number | null; change: number | null };
}

const change = (before: number | null, after: number | null) =>
	before === null || after === null ? null : after - before;

/**
 * Compare a baseline inventory with a later one: per path, then per task, the
 * mean requests and cost per message before and after. A path or task present
 * on one side only reads as null on the other.
 */
export function compareInventories(before: CallInventory, after: CallInventory): InventoryDelta[] {
	const index = (inventory: CallInventory) => new Map(inventory.paths.map((p) => [p.path, p]));
	const old = index(before);
	const now = index(after);
	const deltas: InventoryDelta[] = [];
	for (const path of [...new Set([...old.keys(), ...now.keys()])].sort()) {
		const a = old.get(path);
		const b = now.get(path);
		const pair = (x: number | null | undefined, y: number | null | undefined) => ({
			before: x ?? null,
			after: y ?? null,
			change: change(x ?? null, y ?? null),
		});
		deltas.push({
			path,
			task: null,
			requestsPerMessage: pair(a?.requestsPerMessage.mean, b?.requestsPerMessage.mean),
			costPerMessage: pair(a?.costPerMessage.mean, b?.costPerMessage.mean),
		});
		const tasks = new Set([...Object.keys(a?.byTask ?? {}), ...Object.keys(b?.byTask ?? {})]);
		for (const task of [...tasks].sort()) {
			const x = a?.byTask[task];
			const y = b?.byTask[task];
			deltas.push({
				path,
				task,
				// A task absent on a side that processed messages made zero requests.
				requestsPerMessage: pair(
					x?.requestsPerMessage ?? (a ? 0 : null),
					y?.requestsPerMessage ?? (b ? 0 : null)
				),
				costPerMessage: pair(
					x?.costPerMessage ?? (a ? 0 : null),
					y?.costPerMessage ?? (b ? 0 : null)
				),
			});
		}
	}
	return deltas;
}

/**
 * Ledger rows from an exported `llmUsageEvents` table, one JSON document per
 * line (`npx convex export`, then `llmUsageEvents/documents.jsonl`). Lines that
 * are not ledger rows are skipped and counted, never guessed into shape.
 */
export function ledgerRowsFromJsonl(text: string): { rows: LedgerCallRow[]; skipped: number } {
	const rows: LedgerCallRow[] = [];
	let skipped = 0;
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue;
		let doc: unknown;
		try {
			doc = JSON.parse(line);
		} catch {
			skipped++;
			continue;
		}
		const row = doc as Partial<LedgerCallRow> | null;
		if (
			typeof row?.feature !== 'string' ||
			typeof row.costUsd !== 'number' ||
			typeof row.promptTokens !== 'number' ||
			typeof row.completionTokens !== 'number' ||
			typeof row.totalTokens !== 'number'
		) {
			skipped++;
			continue;
		}
		rows.push(row as LedgerCallRow);
	}
	return { rows, skipped };
}
