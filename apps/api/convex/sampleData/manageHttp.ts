/**
 * Operator-facing HTTP surface for sample data.
 *
 *   POST /sample-data/install   — insert the sample dataset (idempotent)
 *   POST /sample-data/remove    — delete exactly the seed-tagged rows
 *   POST /sample-data/status    — how many seed-tagged rows are present
 *
 * Headers: `X-Instance-Secret: <INSTANCE_SECRET>` on all three.
 *
 * Authentication is the on-box operator secret — the same credential
 * `POST /seed/admin` uses to create the first admin, held in the install's
 * `.env` and never sent to a browser. These endpoints are strictly less
 * powerful than that one: they write and remove tagged demo rows and cannot
 * touch accounts, sessions, or the operator's own data.
 *
 * Unlike `/seed/demo` and `/dev/reset`, they are NOT behind `OWLAT_DEV_MODE` —
 * that guard stays fail-closed exactly as it is, because enabling it on a real
 * install would also unlock the full-wipe endpoint and drop BetterAuth's rate
 * limiting.
 *
 * Removal runs action-side rather than as one big mutation: the tables carrying
 * sample rows are ordinary tenant tables with no `seedTag` index, so finding
 * the rows is a scan, and a year-old install's `contacts` table can be larger
 * than a single transaction may read. Each page is its own transaction.
 */

import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import type { GenericActionCtx, HttpRouter } from 'convex/server';
import type { DataModel, TableNames } from '../_generated/dataModel';
import { getOptional } from '../lib/env';
import { safeCompare } from '../lib/safeCompare';
import { SEEDED_TABLES } from '../seedDemo/pipeline';

/** Ids deleted per mutation. Keeps each delete transaction small and bounded. */
const DELETE_BATCH = 100;

/**
 * Defensive cap on pages scanned per table (`SCAN_PAGE_SIZE` rows each), so a
 * pathological cursor can never spin an action forever. 4k pages covers ~2M
 * rows in one table.
 */
const MAX_PAGES = 4000;

type ActionCtx = GenericActionCtx<DataModel>;

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

function unauthorizedOrNull(request: Request): Response | null {
	const secret = request.headers.get('X-Instance-Secret');
	const expected = getOptional('INSTANCE_SECRET');
	if (!expected || !secret || !safeCompare(secret, expected)) {
		return jsonResponse({ error: 'Unauthorized' }, 401);
	}
	return null;
}

/** Every seed-tagged row id in one table, gathered without deleting anything. */
async function collectTaggedIds(ctx: ActionCtx, table: TableNames): Promise<string[]> {
	const ids: string[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < MAX_PAGES; page++) {
		const result: { ids: string[]; cursor: string | null; isDone: boolean } = await ctx.runQuery(
			internal.sampleData.index.scanTaggedRows,
			{ table, cursor }
		);
		ids.push(...result.ids);
		if (result.isDone) break;
		cursor = result.cursor;
	}
	return ids;
}

/** Seed-tagged row counts per table, omitting tables with none. */
async function countTagged(ctx: ActionCtx): Promise<Record<string, number>> {
	const counts: Record<string, number> = {};
	for (const table of SEEDED_TABLES) {
		const ids = await collectTaggedIds(ctx, table);
		if (ids.length > 0) counts[table] = ids.length;
	}
	return counts;
}

const sampleDataInstallHttp = httpAction(async (ctx, request) => {
	const unauthorized = unauthorizedOrNull(request);
	if (unauthorized) return unauthorized;

	try {
		const summary: { inserted: Record<string, number>; skipped: Record<string, number> } =
			await ctx.runMutation(internal.sampleData.index.install, {});
		return jsonResponse(summary, 200);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Internal error';
		return jsonResponse({ error: message }, 500);
	}
});

const sampleDataRemoveHttp = httpAction(async (ctx, request) => {
	const unauthorized = unauthorizedOrNull(request);
	if (unauthorized) return unauthorized;

	try {
		const deleted: Record<string, number> = {};
		for (const table of SEEDED_TABLES) {
			const ids = await collectTaggedIds(ctx, table);
			let removed = 0;
			for (let i = 0; i < ids.length; i += DELETE_BATCH) {
				removed += await ctx.runMutation(internal.sampleData.index.deleteTaggedRows, {
					table,
					ids: ids.slice(i, i + DELETE_BATCH),
				});
			}
			if (removed > 0) deleted[table] = removed;
		}
		return jsonResponse({ deleted }, 200);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Internal error';
		return jsonResponse({ error: message }, 500);
	}
});

const sampleDataStatusHttp = httpAction(async (ctx, request) => {
	const unauthorized = unauthorizedOrNull(request);
	if (unauthorized) return unauthorized;

	try {
		const present = await countTagged(ctx);
		const total = Object.values(present).reduce((sum, n) => sum + n, 0);
		return jsonResponse({ present, total }, 200);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Internal error';
		return jsonResponse({ error: message }, 500);
	}
});

/**
 * Registered from `http.ts` as one call rather than three inline `http.route`
 * blocks: that file sits right under the 500-LOC ratchet
 * (`scripts/check-file-size.sh`), and the routes document themselves here.
 */
export function registerSampleDataRoutes(http: HttpRouter): void {
	http.route({ path: '/sample-data/install', method: 'POST', handler: sampleDataInstallHttp });
	http.route({ path: '/sample-data/remove', method: 'POST', handler: sampleDataRemoveHttp });
	http.route({ path: '/sample-data/status', method: 'POST', handler: sampleDataStatusHttp });
}
