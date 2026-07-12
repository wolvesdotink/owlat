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
 * Loaders run in topological order based on their declared `dependencies`.
 * Each loader inserts rows tagged with `seedTag: 'demo'` so reset can find
 * them again. Exception: the `accounts` loader writes BetterAuth component
 * rows, which cannot carry the tag — it dedupes by email instead and is only
 * wiped by the full `POST /dev/reset`.
 */

import { v } from 'convex/values';
import type { TableNames } from '../_generated/dataModel';
import { httpAction, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { getOptional } from '../lib/env';
import { safeCompare } from '../lib/safeCompare';
import { devDeploymentResponseOrNull } from '../devShortcuts/_guard';

import accountsFixture from './fixtures/accounts.json';
import topicsFixture from './fixtures/topics.json';
import contactsFixture from './fixtures/contacts.json';
import contactTopicsFixture from './fixtures/contactTopics.json';
import savedBlocksFixture from './fixtures/savedBlocks.json';
import emailTemplatesFixture from './fixtures/emailTemplates.json';
import transactionalEmailsFixture from './fixtures/transactionalEmails.json';
import campaignsFixture from './fixtures/campaigns.json';
import automationsFixture from './fixtures/automations.json';
import webhooksFixture from './fixtures/webhooks.json';
import domainsFixture from './fixtures/domains.json';
import mailboxesFixture from './fixtures/mailboxes.json';

import { accountsLoader } from './loaders/accounts';
import { topicsLoader } from './loaders/topics';
import { contactsLoader } from './loaders/contacts';
import { contactTopicsLoader } from './loaders/contactTopics';
import { savedBlocksLoader } from './loaders/savedBlocks';
import { emailTemplatesLoader } from './loaders/emailTemplates';
import { transactionalEmailsLoader } from './loaders/transactionalEmails';
import { campaignsLoader } from './loaders/campaigns';
import { automationsLoader } from './loaders/automations';
import { webhooksLoader } from './loaders/webhooks';
import { domainsLoader } from './loaders/domains';
import { mailboxesLoader } from './loaders/mailboxes';
import type { Loader, SeedRefs } from './loaders/types';

// Order matters: each entry's `dependencies` reference earlier modules in the
// list. Keeping the list ordered makes the topological sort a single pass.
const LOADERS: Array<{ loader: Loader; records: unknown[] }> = [
	{ loader: accountsLoader, records: accountsFixture },
	{ loader: topicsLoader, records: topicsFixture },
	{ loader: contactsLoader, records: contactsFixture },
	{ loader: contactTopicsLoader, records: contactTopicsFixture },
	{ loader: savedBlocksLoader, records: savedBlocksFixture },
	{ loader: emailTemplatesLoader, records: emailTemplatesFixture },
	{ loader: transactionalEmailsLoader, records: transactionalEmailsFixture },
	{ loader: campaignsLoader, records: campaignsFixture },
	{ loader: automationsLoader, records: automationsFixture },
	{ loader: webhooksLoader, records: webhooksFixture },
	{ loader: domainsLoader, records: domainsFixture },
	{ loader: mailboxesLoader, records: mailboxesFixture },
];

// Tables that may carry `seedTag: 'demo'` rows. Used by reset to wipe them.
const SEEDED_TABLES: TableNames[] = [
	'topics',
	'contactTopics',
	'contacts',
	'contactIdentities',
	'emailBlocks',
	'emailTemplates',
	'transactionalEmails',
	'campaigns',
	'emailSends',
	'automations',
	'automationSteps',
	'webhooks',
	'domains',
	'sendingDomainMtaIdentities',
];

export interface SeedSummary {
	inserted: Record<string, number>;
	skipped: Record<string, number>;
	deleted?: Record<string, number>;
}

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
					const tagged = (row as { seedTag?: string }).seedTag;
					if (tagged === 'demo' || tagged === 'dev-forced') {
						await ctx.db.delete(row._id);
						removed++;
					}
				}
				if (removed > 0) summary.deleted[table] = removed;
			}
		}

		const refs: SeedRefs = {};
		for (const { loader, records } of LOADERS) {
			for (const dep of loader.dependencies) {
				if (!(dep in refs)) {
					throw new Error(
						`Seed loader '${loader.module}' depends on '${dep}', which has not been loaded yet.`
					);
				}
			}
			const result = await loader.load(ctx, records, refs);
			refs[loader.module] = result.ids;
			summary.inserted[loader.module] = result.inserted;
			summary.skipped[loader.module] = result.skipped;
		}

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
		const message = error instanceof Error ? error.message : 'Internal error';
		return jsonResponse({ error: message }, 500);
	}
});

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}
