/**
 * Backfill per-credential `allowedDomains` onto the org's MTA API credentials (H2).
 *
 * The H2 From-forgery guard enforces, at submission, that a message's From domain
 * is in the sending credential's `allowedDomains` set (the org's verified sending
 * domains). Credentials created before this field existed have it unset and stay
 * UNSCOPED at submission — the org-scoped DKIM signer is the only backstop. This
 * migration provisions the set onto those credentials so the From-domain guard has
 * something to enforce.
 *
 * An operator runs
 * `convex run migrations/0040_backfill_credential_allowed_domains:run` once. It
 * gathers the deployment singleton org's VERIFIED sending domains, lists that org's
 * MTA credentials (with full keys, master-key protected), and PATCHes each
 * credential whose `allowedDomains` is empty or unset with that domain list.
 * Idempotent: a credential already carrying a non-empty set is left untouched, so
 * re-running is a no-op and an operator's later manual scoping is never clobbered.
 *
 * GUARD: if the org currently has NO verified sending domains, this patches
 * nothing — setting an empty allow-list would fail closed and lock every credential
 * out of sending. Provision at least one verified domain first, then re-run.
 *
 * Enforcement only takes effect once this has run (and only for credentials it
 * touched); until then legacy credentials stay unscoped at submission.
 */

import { v } from 'convex/values';
import { internalAction, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import { createMtaIdentityManager } from '../lib/emailProviders/mtaIdentity';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { logInfo } from '../lib/runtimeLog';

/** Rows per page. Small enough to stay well inside a query's limits. */
const PAGE_SIZE = 100;

export const listVerifiedDomainsPage = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, args): Promise<{ domains: string[]; cursor: string; isDone: boolean }> => {
		const { page, continueCursor, isDone } = await ctx.db
			.query('domains')
			.withIndex('by_status', (q) => q.eq('status', 'verified'))
			.paginate({ numItems: PAGE_SIZE, cursor: args.cursor });
		return {
			domains: page.map((d) => d.domain.toLowerCase()),
			cursor: continueCursor,
			isDone,
		};
	},
});

export const run = internalAction({
	args: {},
	handler: async (
		ctx
	): Promise<{
		patched: number;
		alreadyScoped: number;
		skipped: number;
		verifiedDomains: number;
	}> => {
		const organizationId = await getSingletonOrganizationId(ctx);

		// Gather the org's verified sending domains.
		const verifiedDomains: string[] = [];
		let cursor: string | null = null;
		for (let pages = 0; pages < 1000; pages++) {
			const result: { domains: string[]; cursor: string; isDone: boolean } = await ctx.runQuery(
				internal.migrations['0040_backfill_credential_allowed_domains'].listVerifiedDomainsPage,
				{ cursor }
			);
			verifiedDomains.push(...result.domains);
			if (result.isDone) break;
			cursor = result.cursor;
		}
		// De-duplicate (defensive; the MTA normalizes again on write).
		const domainList = [...new Set(verifiedDomains)];

		const mta = createMtaIdentityManager();
		const credentials = await mta.listOrgCredentials(organizationId);

		// No verified domains ⇒ do not patch: an empty allow-list fails closed and
		// would lock every credential out of sending.
		if (domainList.length === 0) {
			logInfo(
				`[0040] No verified sending domains for the org; skipping ${credentials.length} credential(s)`
			);
			return {
				patched: 0,
				alreadyScoped: 0,
				skipped: credentials.length,
				verifiedDomains: 0,
			};
		}

		let patched = 0;
		let alreadyScoped = 0;
		for (const { apiKey, credential } of credentials) {
			// Already scoped to a non-empty set — leave the operator's choice intact.
			if (credential.allowedDomains && credential.allowedDomains.length > 0) {
				alreadyScoped++;
				continue;
			}
			await mta.setCredentialAllowedDomains(apiKey, domainList);
			patched++;
		}

		logInfo(
			`[0040] Credential allowedDomains backfill: ${JSON.stringify({
				patched,
				alreadyScoped,
				verifiedDomains: domainList.length,
			})}`
		);
		return { patched, alreadyScoped, skipped: 0, verifiedDomains: domainList.length };
	},
});
