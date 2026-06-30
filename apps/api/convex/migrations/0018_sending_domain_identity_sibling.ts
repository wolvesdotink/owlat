/**
 * ADR-0018 — Migrate provider-specific columns from `domains` rows into the
 * per-provider **Sending domain identity** sibling tables.
 *
 * Legacy fields on `domains`:
 *   mtaDkimSelector?
 *   sesDkimTokens?
 *   sesVerificationToken?
 *   sesVerificationStatus?      (deleted — redundant with verificationResults.sesStatus)
 *   sesRegistrationError?
 *   registrationError?
 *
 * After this migration:
 *   - MTA-registered domains have a `sendingDomainMtaIdentities` row with
 *     `{ domainId, dkimSelector }`.
 *   - SES-registered domains have a `sendingDomainSesIdentities` row with
 *     `{ domainId, dkimTokens, verificationToken }`.
 *   - `domains.lastRegistrationError` is populated from the union of the
 *     legacy `registrationError ?? sesRegistrationError`.
 *
 * The legacy column drops in `schema/domains.ts` should land in a second
 * deploy after this backfill confirms green — the migration only writes
 * the new tables and the rename field.
 *
 * Idempotent: re-running patches existing identity rows rather than
 * duplicating.
 *
 * Note: Convex schema validation may block reading rows with the legacy
 * shape once the new validator is deployed. If so, temporarily widen the
 * `domains` validator to accept the legacy fields during the migration
 * window, run this migration, then drop them.
 */

import { internalMutation } from '../_generated/server';

// The pre-ADR-0018 `domains` shape — these provider-specific columns are no
// longer in the schema's `Doc` type, so rows are read through this view.
interface LegacyDomain {
	providerType?: string;
	mtaDkimSelector?: string;
	sesDkimTokens?: string[];
	sesVerificationToken?: string;
	registrationError?: string;
	sesRegistrationError?: string;
	lastRegistrationError?: string;
}

export const run = internalMutation({
	args: {},
	handler: async (ctx) => {
		let mtaIdentitiesWritten = 0;
		let sesIdentitiesWritten = 0;
		let errorsRenamed = 0;
		let skipped = 0;

		const rows = await ctx.db.query('domains').collect();
		for (const row of rows) {
			const legacy = row as unknown as LegacyDomain;
			const providerType: string | undefined =
				legacy.providerType ?? (legacy.sesDkimTokens ? 'ses' : undefined);

			let patched = false;

			// Migrate MTA-specific column → sibling row.
			if (providerType === 'mta' && legacy.mtaDkimSelector) {
				const existing = await ctx.db
					.query('sendingDomainMtaIdentities')
					.withIndex('by_domain', (q) => q.eq('domainId', row._id))
					.first();
				const now = Date.now();
				if (existing) {
					await ctx.db.patch(existing._id, {
						dkimSelector: legacy.mtaDkimSelector,
						updatedAt: now,
					});
				} else {
					await ctx.db.insert('sendingDomainMtaIdentities', {
						domainId: row._id,
						dkimSelector: legacy.mtaDkimSelector,
						createdAt: now,
						updatedAt: now,
					});
				}
				mtaIdentitiesWritten++;
			}

			// Migrate SES-specific columns → sibling row.
			if (
				providerType === 'ses' &&
				Array.isArray(legacy.sesDkimTokens) &&
				legacy.sesDkimTokens.length > 0 &&
				typeof legacy.sesVerificationToken === 'string' &&
				legacy.sesVerificationToken.length > 0
			) {
				const existing = await ctx.db
					.query('sendingDomainSesIdentities')
					.withIndex('by_domain', (q) => q.eq('domainId', row._id))
					.first();
				const now = Date.now();
				if (existing) {
					await ctx.db.patch(existing._id, {
						dkimTokens: legacy.sesDkimTokens,
						verificationToken: legacy.sesVerificationToken,
						updatedAt: now,
					});
				} else {
					await ctx.db.insert('sendingDomainSesIdentities', {
						domainId: row._id,
						dkimTokens: legacy.sesDkimTokens,
						verificationToken: legacy.sesVerificationToken,
						createdAt: now,
						updatedAt: now,
					});
				}
				sesIdentitiesWritten++;
			}

			// Coalesce error fields into the new `lastRegistrationError`.
			const newErr =
				legacy.lastRegistrationError ??
				legacy.registrationError ??
				legacy.sesRegistrationError ??
				undefined;
			if (newErr !== undefined && legacy.lastRegistrationError === undefined) {
				await ctx.db.patch(row._id, { lastRegistrationError: newErr });
				errorsRenamed++;
				patched = true;
			}

			// Skip count includes rows where there's nothing to migrate (already
			// migrated or never had provider-specific data).
			if (
				providerType !== 'mta' &&
				providerType !== 'ses' &&
				!patched
			) {
				skipped++;
			}
		}

		return {
			mtaIdentitiesWritten,
			sesIdentitiesWritten,
			errorsRenamed,
			skipped,
			total: rows.length,
		};
	},
});
