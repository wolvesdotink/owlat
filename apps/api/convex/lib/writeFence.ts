/**
 * THE WORKSPACE WRITE FENCE.
 *
 * While a workspace deletion job is active (`workspaceDeletionJobs.isActive`),
 * no transaction may insert, patch or replace a row in a table the deletion
 * sweeps. Without it the sweep is a race: a contact created after the
 * `contacts` step, a webhook payload stored after `webhookPayloads`, or a cron
 * re-creating `instanceSettings` survives the whole walk (#898).
 *
 * The check lives in ONE place, the database handle every builder hands its
 * handler:
 *
 *   - every public mutation builder in `lib/authedFunctions.ts` (and so every
 *     `featureGated` composition of them) wraps its `ctx.db` here;
 *   - `internalMutation` below is the fenced counterpart of the raw builder, and
 *     `scripts/check-write-fence.ts` makes it the only one a module may use.
 *     Crons, scheduled chains, HTTP routes (API-key, inbound webhooks, service
 *     callbacks) and actions all write through internal mutations, so an action
 *     that was already running when the deletion began has its commit refused
 *     at the mutation it calls, however late that is.
 *
 * The deletion worker (`workspaces/deletion/walker.ts`) is the explicit
 * exception: it builds on the raw builder, and the lint allows that one module.
 *
 * Only writes that would put data back are refused. Deletes pass (removing a
 * row can only help the sweep), and tables outside the deletion's registry
 * (auth identity, instance infrastructure, the job table itself) stay writable,
 * so sign-in, updates and backups keep working while the workspace is emptied.
 * Reads are never fenced.
 *
 * Cost when no deletion is running: one indexed read of an empty range, once
 * per transaction, and only in a transaction that writes a swept table (or
 * patches a row by bare id).
 */

import {
	internalMutation as rawInternalMutation,
	type DatabaseReader,
	type MutationCtx,
} from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { throwInvalidState } from '../_utils/errors';
import { organizationDeletionTableValidator } from '../workspaces/deletion/steps/_common';
import { NON_TENANT_TABLES } from './tenantTables';

/** Every table the workspace deletion sweeps: the ones the fence closes. */
const FENCED_TABLES: ReadonlySet<string> = new Set(
	organizationDeletionTableValidator.members.map((member) => member.value)
);

/**
 * The writable tables, for resolving an id-only `patch(id, …)`. Short on
 * purpose: the lookup runs only while a deletion is active, one
 * `normalizeId` per candidate.
 */
const UNFENCED_TABLES = NON_TENANT_TABLES.filter((table) => !FENCED_TABLES.has(table));

export type WorkspaceDeletionJob = Doc<'workspaceDeletionJobs'>;

/** The deletion job in progress, or `null`. At most one row is ever active. */
export async function readActiveWorkspaceDeletion(
	db: DatabaseReader
): Promise<WorkspaceDeletionJob | null> {
	return await db
		.query('workspaceDeletionJobs')
		.withIndex('by_is_active', (q) => q.eq('isActive', true))
		.first();
}

function refuseWrite(job: WorkspaceDeletionJob): never {
	throwInvalidState(
		'This workspace is being deleted. Changes are not accepted until the deletion has finished.',
		{ reason: 'workspace_deletion_in_progress', generation: job.generation }
	);
}

type Writer = MutationCtx['db'];

/**
 * `ctx` with a database handle that refuses fenced writes while a deletion job
 * is active. The job is looked up lazily, on the first insert/patch/replace,
 * and the answer is kept for the rest of the transaction: Convex transactions
 * are serializable, so a job that starts after the read conflicts with this
 * transaction and re-runs it, and the re-run sees the job.
 */
export function fenceWorkspaceWrites<Ctx extends { db: Writer }>(ctx: Ctx): Ctx {
	const db = ctx.db;
	let activeJob: Promise<WorkspaceDeletionJob | null> | undefined;

	/** `table` is null when the call named only an id; `id` resolves it then. */
	async function guard(table: string | null, id?: unknown): Promise<void> {
		// A named table outside the registry never needs the job.
		if (table !== null && !FENCED_TABLES.has(table)) return;
		activeJob ??= readActiveWorkspaceDeletion(db);
		const job = await activeJob;
		if (job === null) return;
		// A bare id is resolved only now, while a deletion runs. An id that
		// belongs to none of the writable tables is fenced: unknown fails closed.
		if (table === null && tableOfUnfencedId(db, id) !== null) return;
		refuseWrite(job);
	}

	const fencedDb = new Proxy(db, {
		get(target, prop) {
			const value: unknown = Reflect.get(target, prop, target);
			if (typeof value !== 'function') return value;
			const method = value as (...args: unknown[]) => unknown;
			if (prop === 'insert') {
				return async (table: string, doc: unknown) => {
					await guard(table);
					return await method.call(target, table, doc);
				};
			}
			if (prop === 'patch' || prop === 'replace') {
				// `(table, id, value)` names the table; `(id, value)` does not.
				return async (...args: unknown[]) => {
					if (args.length >= 3 && typeof args[0] === 'string') await guard(args[0]);
					else await guard(null, args[0]);
					return await method.apply(target, args);
				};
			}
			if (prop === 'table') {
				return (table: string) => fenceTableWriter(method.call(target, table), table, guard);
			}
			return method.bind(target);
		},
	});
	return { ...ctx, db: fencedDb };
}

function tableOfUnfencedId(db: Writer, id: unknown): string | null {
	if (typeof id !== 'string') return null;
	for (const table of UNFENCED_TABLES) {
		if (db.normalizeId(table, id) !== null) return table;
	}
	return null;
}

/** The `db.table(name)` writer: its table is known, so every write names it. */
function fenceTableWriter(
	writer: unknown,
	table: string,
	guard: (table: string) => Promise<void>
): unknown {
	return new Proxy(writer as object, {
		get(target, prop) {
			const value: unknown = Reflect.get(target, prop, target);
			if (typeof value !== 'function') return value;
			const method = value as (...args: unknown[]) => unknown;
			if (prop === 'insert' || prop === 'patch' || prop === 'replace') {
				return async (...args: unknown[]) => {
					await guard(table);
					return await method.apply(target, args);
				};
			}
			return method.bind(target);
		},
	});
}

type MutationHandler = (ctx: MutationCtx, args: unknown) => unknown;

/**
 * A mutation builder whose handlers get `fenceWorkspaceWrites(ctx)` instead of
 * `ctx`. Same signature and generated types as the builder it wraps; accepts
 * both the config object and the bare-handler shorthand.
 */
export function fenceMutationBuilder<Builder>(builder: Builder): Builder {
	const build = builder as unknown as (definition: unknown) => unknown;
	return ((definition: unknown) => {
		if (typeof definition === 'function') {
			const handler = definition as MutationHandler;
			return build((ctx: MutationCtx, args: unknown) => handler(fenceWorkspaceWrites(ctx), args));
		}
		const config = definition as { handler: MutationHandler };
		return build({
			...config,
			handler: (ctx: MutationCtx, args: unknown) => config.handler(fenceWorkspaceWrites(ctx), args),
		});
	}) as unknown as Builder;
}

/**
 * The fenced `internalMutation`: import it from here, never from
 * `_generated/server` (`scripts/check-write-fence.ts`).
 */
export const internalMutation = fenceMutationBuilder(rawInternalMutation);
