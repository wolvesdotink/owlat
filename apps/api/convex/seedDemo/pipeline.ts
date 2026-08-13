/**
 * The seed pipeline itself: the loader graph, the seed-tag vocabulary, and the
 * table list a tagged sweep has to walk. No Convex functions live here — only
 * the plumbing its two callers share.
 *
 * Two callers, two audiences:
 *   - `seedDemo/index.ts` — `POST /seed/demo`, DEV deployments only
 *     (`OWLAT_DEV_MODE`), runs EVERY loader, including the dummy teammate
 *     sign-ins and their hosted mailboxes.
 *   - `sampleData/*` — the opt-in "explore with sample data" path a REAL
 *     install can use. Runs `SAMPLE_DATA_MODULES` only: the same content, minus
 *     anything that would put throwaway credentials or an unowned mailbox on a
 *     production instance.
 *
 * Both write the same `seedTag`, so one sweep removes either one exactly.
 */

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { TableNames } from '../_generated/dataModel';

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
import complianceTelemetryFixture from './fixtures/complianceTelemetry.json';

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
import { complianceTelemetryLoader } from './loaders/complianceTelemetry';
import type { Loader, SeedRefs } from './loaders/types';

// Order matters: each entry's `dependencies` reference earlier modules in the
// list. Keeping the list ordered makes the topological sort a single pass.
export const LOADERS: Array<{ loader: Loader; records: unknown[] }> = [
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
	{ loader: complianceTelemetryLoader, records: complianceTelemetryFixture },
];

/**
 * The loaders a REAL install may run.
 *
 * Excluded on purpose:
 *   - `accounts` — writes BetterAuth users whose passwords are published
 *     fixture hashes. Never on an instance that is reachable by anyone else.
 *   - `mailboxes` — hosted mailboxes are provisioned FOR those accounts (and
 *     `seedDemo/messages.ts` delivers into them). Without the accounts they
 *     have no owner, and they are BetterAuth/tenant rows the tagged sweep
 *     cannot take back.
 *
 * Everything else is `seedTag`-tagged and removable, so the subset must stay
 * dependency-closed: `applyLoaders` throws if a selected loader depends on an
 * excluded one.
 */
export const SAMPLE_DATA_MODULES: readonly string[] = [
	'topics',
	'contacts',
	'contactTopics',
	'savedBlocks',
	'emailTemplates',
	'transactionalEmails',
	'campaigns',
	'automations',
	'webhooks',
	'domains',
	'complianceTelemetry',
];

/** Tables that may carry seed-tagged rows. Used by every tagged sweep. */
export const SEEDED_TABLES: TableNames[] = [
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
	'gmailVolumeBuckets',
	'gmailDomainVolumeRollups',
	'gmailDomainVolumeRollupJobs',
];

/**
 * Tags a sweep removes: `demo` is written by every loader, `dev-forced` by
 * `devShortcuts/forceVerifyDomain` (which never tags a row the operator
 * created). Anything untagged is the operator's own data and is never touched.
 */
export const REMOVABLE_SEED_TAGS: readonly string[] = ['demo', 'dev-forced'];

export interface SeedSummary {
	inserted: Record<string, number>;
	skipped: Record<string, number>;
	deleted?: Record<string, number>;
}

export function isRemovableSeedRow(row: unknown): boolean {
	const tag = (row as { seedTag?: string }).seedTag;
	return tag !== undefined && REMOVABLE_SEED_TAGS.includes(tag);
}

/**
 * Run the loader graph, optionally restricted to `modules`. A restricted run
 * whose selection is not dependency-closed throws rather than inserting a
 * half-linked dataset.
 */
export async function applyLoaders(
	ctx: MutationCtx,
	modules?: readonly string[]
): Promise<{ inserted: Record<string, number>; skipped: Record<string, number> }> {
	const selected = modules ? new Set(modules) : null;
	const inserted: Record<string, number> = {};
	const skipped: Record<string, number> = {};
	const refs: SeedRefs = {};

	for (const { loader, records } of LOADERS) {
		if (selected && !selected.has(loader.module)) continue;
		for (const dep of loader.dependencies) {
			if (!(dep in refs)) {
				throw new Error(
					`Seed loader '${loader.module}' depends on '${dep}', which has not been loaded yet.`
				);
			}
		}
		const result = await loader.load(ctx, records, refs);
		refs[loader.module] = result.ids;
		inserted[loader.module] = result.inserted;
		skipped[loader.module] = result.skipped;
	}

	return { inserted, skipped };
}

/**
 * Collect the ids of seed-tagged rows in one table, one page at a time.
 *
 * `SEEDED_TABLES` holds ordinary tenant tables with no `seedTag` index, so
 * finding tagged rows is a scan. On a dev instance that is a handful of rows;
 * on a real install that has been running for a year the table can be far
 * larger than a single transaction may read — hence the page-at-a-time shape,
 * driven from an action. The scan never deletes, so no cursor it hands back can
 * be invalidated by our own writes.
 */
export async function pageSeedTaggedIds(
	ctx: QueryCtx,
	table: TableNames,
	cursor: string | null,
	numItems: number
): Promise<{ ids: string[]; cursor: string | null; isDone: boolean }> {
	const page = await ctx.db.query(table).paginate({ cursor, numItems });
	return {
		ids: page.page.filter(isRemovableSeedRow).map((row) => row._id as string),
		cursor: page.continueCursor,
		isDone: page.isDone,
	};
}
