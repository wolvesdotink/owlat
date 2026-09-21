/**
 * Backfill DKIM key org-ownership onto existing domains (H2).
 *
 * The H2 cross-tenant DKIM guard binds each domain's DKIM key to its owning
 * organization (`mta:dkim:{domain}` gains an `organizationId` field), and the
 * signer refuses to sign under another tenant's key. New keys are now born owned
 * (the register action threads the singleton org), but keys generated before this
 * change carry no owner, so the guard has nothing to enforce for them. This
 * migration backfills ownership onto those legacy keys.
 *
 * An operator runs `convex run migrations/0039_backfill_dkim_ownership:run` once.
 * It walks the `domains` table page-at-a-time and, for each OWN-MTA domain, POSTs
 * `/dkim/{domain}/register` with the deployment's singleton org. That call is
 * idempotent: it backfills ownership ONLY onto an unowned key (never touching the
 * selector or private key, so signing stays byte-stable), is a no-op for a key
 * already owned by that org, and 409s a true cross-org clash — which we log and
 * skip rather than aborting the whole run. Safe to re-run and to resume after an
 * interrupt.
 *
 * Enforcement only takes effect once this has run; until then legacy keys stay
 * unowned and the signer's fail-closed backstop is the only guard.
 */

import { v } from 'convex/values';
import { internalAction, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import { createMtaIdentityManager } from '../lib/emailProviders/mtaIdentity';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { logError, logInfo } from '../lib/runtimeLog';

/** Rows per page. Small enough to stay well inside a query's limits. */
const PAGE_SIZE = 100;

interface DomainRow {
	domain: string;
	providerType: string | undefined;
}

export const listDomainsPage = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	handler: async (
		ctx,
		args
	): Promise<{ domains: DomainRow[]; cursor: string; isDone: boolean }> => {
		const { page, continueCursor, isDone } = await ctx.db
			.query('domains')
			.paginate({ numItems: PAGE_SIZE, cursor: args.cursor });
		return {
			domains: page.map((d) => ({ domain: d.domain, providerType: d.providerType })),
			cursor: continueCursor,
			isDone,
		};
	},
});

/**
 * Is this row's PRIMARY provider our own MTA — including the legacy rows that
 * never recorded one? Mirrors `isOwnPrimarySendingDomain` (domains/providers),
 * inlined here so this convex-runtime action does not import the provider
 * registry (which pulls the node-only SES SDK). A row for another provider
 * (`ses`/`mandrill`) has no MTA DKIM key, so registering it would MINT a bogus
 * one — we skip those.
 */
function isOwnMtaDomain(providerType: string | undefined): boolean {
	return providerType === undefined || providerType === 'mta';
}

export const run = internalAction({
	args: {},
	handler: async (
		ctx
	): Promise<{ owned: number; alreadyOwned: number; conflicts: number; skipped: number }> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		const mta = createMtaIdentityManager();

		let owned = 0;
		let alreadyOwned = 0;
		let conflicts = 0;
		let skipped = 0;

		let cursor: string | null = null;
		// Bounded so a pagination bug can never spin forever; at PAGE_SIZE=100 this
		// covers 100k domains in one invocation, and a larger set finishes by
		// re-running (the walk restarts from the top and re-owns nothing).
		for (let pages = 0; pages < 1000; pages++) {
			const result: { domains: DomainRow[]; cursor: string; isDone: boolean } = await ctx.runQuery(
				internal.migrations['0039_backfill_dkim_ownership'].listDomainsPage,
				{
					cursor,
				}
			);

			for (const { domain, providerType } of result.domains) {
				if (!isOwnMtaDomain(providerType)) {
					skipped++;
					continue;
				}
				try {
					// returnPathHost omitted (undefined) ⇒ no body field for it ⇒ any
					// existing per-domain return-path override is preserved untouched.
					const registration = await mta.registerDomain(domain, undefined, organizationId);
					if (registration.ownership === 'unchanged') {
						alreadyOwned++;
					} else {
						owned++;
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (message.includes('(409)')) {
						// A key already owned by a DIFFERENT org — never move it silently.
						conflicts++;
						logError(`[0039] DKIM ownership conflict for ${domain}, skipping:`, message);
						continue;
					}
					// A non-conflict failure (e.g. the MTA is unreachable) is not
					// per-domain — surface it so the operator can fix it and re-run.
					throw error;
				}
			}

			if (result.isDone) break;
			cursor = result.cursor;
		}

		logInfo(
			`[0039] DKIM ownership backfill: ${JSON.stringify({ owned, alreadyOwned, conflicts, skipped })}`
		);
		return { owned, alreadyOwned, conflicts, skipped };
	},
});
