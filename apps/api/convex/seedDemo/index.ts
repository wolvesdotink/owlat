/**
 * Demo seed entry point.
 *
 * `POST /seed/demo`
 *   Headers: X-Instance-Secret: <secret>
 *   Query:   ?reset=true to wipe seed-tagged rows first
 *
 * Protected by:
 *   1. `safeCompare` against `INSTANCE_SECRET`
 *   2. `assertDevDeployment()` — refuses prod-prefixed deployments
 *
 * DEV ONLY, and it stays that way: this endpoint seeds the dummy teammate
 * sign-ins whose passwords are published fixture hashes. A real install that
 * wants demo content uses the sample-data path instead (`sampleData/`,
 * `POST /sample-data/install`), which runs the same loaders minus the
 * accounts/mailboxes and needs no dev mode.
 *
 * Loaders run in topological order based on their declared `dependencies`
 * (see `./pipeline`). Each loader inserts rows tagged with `seedTag: 'demo'`
 * so reset can find them again. Exception: the `accounts` loader writes
 * BetterAuth component rows, which cannot carry the tag — it dedupes by email
 * instead and is only wiped by the full `POST /dev/reset`.
 */

import { v } from 'convex/values';
import { httpAction, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { getOptional } from '../lib/env';
import { safeCompare } from '../lib/safeCompare';
import { logError } from '../lib/runtimeLog';
import { devDeploymentResponseOrNull } from '../devShortcuts/_guard';
import { applyLoaders, isRemovableSeedRow, SEEDED_TABLES, type SeedSummary } from './pipeline';

export type { SeedSummary } from './pipeline';

export const runSeedDemo = internalMutation({
	args: {
		reset: v.boolean(),
	},
	handler: async (ctx, { reset }): Promise<SeedSummary> => {
		const summary: SeedSummary = { inserted: {}, skipped: {} };

		if (reset) {
			summary.deleted = {};
			for (const table of SEEDED_TABLES) {
				const rows = await ctx.db.query(table).collect(); // bounded: dev-only seed table
				let removed = 0;
				for (const row of rows) {
					if (isRemovableSeedRow(row)) {
						await ctx.db.delete(row._id);
						removed++;
					}
				}
				if (removed > 0) summary.deleted[table] = removed;
			}
		}

		const { inserted, skipped } = await applyLoaders(ctx);
		summary.inserted = inserted;
		summary.skipped = skipped;
		return summary;
	},
});

export const seedDemoHttp = httpAction(async (ctx, request) => {
	const devResp = devDeploymentResponseOrNull();
	if (devResp) return devResp;

	const secret = request.headers.get('X-Instance-Secret');
	const expected = getOptional('INSTANCE_SECRET');
	if (!expected || !secret || !safeCompare(secret, expected)) {
		return jsonResponse({ error: 'Unauthorized' }, 401);
	}

	const url = new URL(request.url);
	const reset = url.searchParams.get('reset') === 'true';

	try {
		const summary = await ctx.runMutation(internal.seedDemo.index.runSeedDemo, { reset });
		// Demo threads for the seeded team inboxes run action-side (not as a
		// Loader): the raw message blob must land in `_storage` first, and only
		// actions can store blobs. Runs after the mutation so the mailboxes exist.
		const messages: { inserted: number; skipped: number } = await ctx.runAction(
			internal.seedDemo.messages.seedMailboxMessages,
			{}
		);
		summary.inserted['mailboxMessages'] = messages.inserted;
		summary.skipped['mailboxMessages'] = messages.skipped;
		return jsonResponse(summary, 200);
	} catch (error) {
		// Locked error envelope — log the real cause server-side, return a fixed message.
		logError('[seedDemo] demo seed failed:', error);
		return jsonResponse({ error: 'Internal error' }, 500);
	}
});

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}
