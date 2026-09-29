/**
 * Copy the hot fields off shared documents into their own rows (migration 0046,
 * plan 2.4).
 *
 *   - `instanceSettings.featureFlags` / `pluginCapabilityGrants` → the
 *     `featureFlagSettings` singleton.
 *   - the counters and telemetry on `instanceSettings` → one `instanceCounters`
 *     row per family (contacts, inbox, sends, mtaHealth, deliveryTest).
 *   - `mailboxes.usedBytes` / `usageRevision` → one `mailboxUsage` row per mailbox.
 *
 * The code that shipped with it already reads the new rows with a fallback to
 * the old fields and creates a missing row on its first write, so this
 * migration is not needed for correctness. It makes every reader stop
 * consulting the old fields, which the later narrowing step (dropping them from
 * the schema) depends on. Background, idempotent and safe to re-run: a row
 * that already exists is left alone, so a value written since the deploy is
 * never overwritten with the stale copy.
 *
 *   npx convex run migrations/0046_split_hot_rows:run
 */

import { v } from 'convex/values';
import { internalAction, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { ensureFeatureFlagSettings } from '../lib/featureFlagSettings';
import {
	ensureInstanceCounter,
	INSTANCE_COUNTER_FIELDS,
	type InstanceCounterKey,
} from '../lib/instanceCounters';
import { ensureMailboxUsage } from '../mail/mailboxUsage';
import { logInfo } from '../lib/runtimeLog';

const PAGE_SIZE = 100;

export const splitInstanceSettings = internalMutation({
	args: {},
	handler: async (ctx): Promise<{ featureFlagSettings: boolean; counters: number }> => {
		const featureFlagSettings = await ensureFeatureFlagSettings(ctx);
		let counters = 0;
		for (const key of Object.keys(INSTANCE_COUNTER_FIELDS) as InstanceCounterKey[]) {
			if (await ensureInstanceCounter(ctx, key)) counters++;
		}
		return { featureFlagSettings, counters };
	},
});

export const splitMailboxUsagePage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db.query('mailboxes').paginate({ numItems: PAGE_SIZE, cursor });
		let created = 0;
		for (const mailbox of result.page) {
			if (await ensureMailboxUsage(ctx, mailbox)) created++;
		}
		return { created, cursor: result.continueCursor, isDone: result.isDone };
	},
});

export const run = internalAction({
	args: {},
	handler: async (
		ctx
	): Promise<{ featureFlagSettings: boolean; counters: number; mailboxUsage: number }> => {
		const instance = await ctx.runMutation(
			internal.migrations['0046_split_hot_rows'].splitInstanceSettings,
			{}
		);
		let cursor: string | null = null;
		let mailboxUsage = 0;
		for (;;) {
			const page: { created: number; cursor: string; isDone: boolean } = await ctx.runMutation(
				internal.migrations['0046_split_hot_rows'].splitMailboxUsagePage,
				{ cursor }
			);
			mailboxUsage += page.created;
			if (page.isDone) break;
			cursor = page.cursor;
		}
		const result = { ...instance, mailboxUsage };
		logInfo('migration.0046_split_hot_rows', result);
		return result;
	},
});
