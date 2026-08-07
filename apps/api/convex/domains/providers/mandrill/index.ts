/**
 * Mandrill (Mailchimp Transactional) sending domain provider adapter.
 *
 * Owns the Mandrill-side surface of one **Sending domain** — the provider API
 * calls (`registerDomain`, `runProviderCheck`) and the rows this kind keeps in
 * the GENERIC `sendingDomainRelayIdentities` table (Mandrill plan D7: the per-provider
 * sibling pattern stopped at `sendingDomainMtaIdentities` /
 * `sendingDomainSesIdentities`, and Mandrill is the first kind after it).
 *
 * Three things differ from the SES adapter, and each one is a fact about
 * Mandrill rather than a shortcut:
 *
 *  - **No per-domain key material.** Mandrill signs with one shared `mandrill`
 *    selector, so the DNS is derived (`./records.ts`), not remembered. The
 *    identity row therefore stores STATE — what Mandrill can see, and whether
 *    ownership cleared — rather than tokens.
 *  - **Mandrill does the DNS lookups.** `senders/check-domain` reports SPF and
 *    DKIM validity from Mandrill's own view, so this adapter runs no DNS crawl
 *    of its own; what we persist is Mandrill's verdict, timestamped.
 *  - **Nothing to delete.** Mandrill's API has no sender-domain removal call
 *    (`senders/*` is add / check / verify / list), so `deleteFromProvider` is a
 *    documented no-op rather than a best-effort call that would always fail.
 *
 * Per ADR-0018, extended by Mandrill plan D6/D7 (plan numbers in this folder
 * are the Mandrill plan's — qualified in `../index.ts`).
 */

import { internal } from '../../../_generated/api';
import { logError } from '../../../lib/runtimeLog';
import { getSingletonOrganizationId } from '../../../lib/sessionOrganization';
import { relayIdentityProvisioningIsSettled } from '../relayIdentityPersistence';
import { addSenderDomain, checkSenderDomain } from './api';
import { buildMandrillIdentity, describeMandrillIdentity } from './identity';
import { loadMandrillRow, resolveDomainName, upsertMandrillIdentity } from './persistence';
import { buildMandrillDnsRecords } from './records';
import { mandrillReferenceArm, mandrillRelayDomainVerified } from './relayVerification';
import type { ProviderCheckResult, RelayProvingProviderModule } from '../types';

// `RelayProvingProviderModule`, not the plain module type: the catalog declares
// `domainVerification: 'api'` for this kind, and that promise is only worth
// something if the three relay seams below are REQUIRED here (see the type's
// own comment, and `../index.ts`'s `_relayProofTypecheck`).
export const mandrillProvider: RelayProvingProviderModule<'mandrill'> = {
	kind: 'mandrill',

	/**
	 * Register the domain on the Mandrill account and return what to publish.
	 *
	 * THROWS on any non-`ok` outcome, per the contract: the generic register
	 * action turns a throw into the `registering → failed` transition with the
	 * message attached, which is the surface an operator actually reads. A
	 * missing/rejected key and a Mandrill outage both belong there — neither
	 * produced an identity.
	 *
	 * `options.returnPathHost` is ignored, and deliberately: Mandrill mints its
	 * own bounce local part, so there is no custom MAIL FROM host to reflect or
	 * publish (D5). `domains.create` already refuses a return-path host for any
	 * kind but MTA/SES; this is the quieter second half of the same rule.
	 */
	async registerDomain(domain) {
		const result = await addSenderDomain(domain);
		if (result.outcome !== 'ok') {
			throw new Error(`Mandrill add-domain failed (${result.outcome}): ${result.error}`);
		}
		return {
			dnsRecords: buildMandrillDnsRecords(domain),
			identity: buildMandrillIdentity(result.state, Date.now()),
		};
	},

	/**
	 * No-op: Mandrill exposes no sender-domain removal endpoint. Removing a
	 * domain from the account is a dashboard action, and the identity row this
	 * adapter owns is dropped by `clearIdentity` either way, so nothing is left
	 * dangling in OUR data.
	 */
	async deleteFromProvider() {
		return;
	},

	describeIdentity(identity) {
		return describeMandrillIdentity(identity);
	},

	/**
	 * The DNS verifier's per-provider check. Mandrill re-tests the published
	 * records from its own view, so this is one call rather than a lookup pass.
	 *
	 * Never throws — an outage is `{ verified: false, lastError }`, exactly as
	 * the SES adapter reports a failed status call, and the lifecycle's reducer
	 * combines it with the generic DNS rule.
	 */
	async runProviderCheck(domain): Promise<ProviderCheckResult> {
		const result = await checkSenderDomain(domain);
		if (result.outcome === 'ok') {
			const identity = buildMandrillIdentity(result.state, Date.now());
			return {
				verified: identity.status === 'verified',
				...(identity.status === 'verified'
					? {}
					: { lastError: `Mandrill status: ${describeMandrillIdentity(identity)}` }),
			};
		}
		logError(`[MANDRILL] check-domain ${result.outcome} for ${domain}:`, result.error);
		return { verified: false, lastError: `Mandrill check error: ${result.error}` };
	},

	// The relay-verification read seam (Mandrill D6) and the alignment pre-flight's
	// second arm (Mandrill P3.1) — both pure reads of the identity row; see
	// `./relayVerification.ts`.
	relayDomainVerified: mandrillRelayDomainVerified,
	describeReferenceArm: mandrillReferenceArm,

	/**
	 * The relay-identity backfill for the domains that predate the fallback
	 * being switched to Mandrill. The existence read is on the GENERIC
	 * `sendingDomainRelayIdentities` row (Mandrill D7) rather than on a sibling table of
	 * its own, which is the only thing that differs from the SES adapter's
	 * implementation of the same contract.
	 *
	 * The caller hands over the whole domain doc, so the name this table keys on
	 * is read straight off it — no `resolveDomainName` round-trip per drained
	 * domain, and no "the row vanished" branch to reason about.
	 *
	 * WHEN to schedule is not a fact about Mandrill. `reprovision`, the existence
	 * read, and the lowercasing that read needs (nothing in the schema forces a
	 * `domains` row's name lowercase, and every row in this table is keyed on the
	 * lowercased one) are one rule about the SHARED row, so it is asked of
	 * {@link relayIdentityProvisioningIsSettled} — where it is argued in full and
	 * where the bundled plugin tier asks exactly the same question. Repeating is
	 * safe: `mandrillRelay.provision` re-registers and `storeIdentity` upserts.
	 */
	async ensureRelayIdentity(ctx, domain, options) {
		if (await relayIdentityProvisioningIsSettled(ctx, 'mandrill', domain.domain, options)) return;
		await ctx.scheduler.runAfter(0, internal.domains.mandrillRelay.provision, {
			domainId: domain._id,
		});
	},

	/**
	 * The due-check sweep's dispatch arm for this kind — re-ask Mandrill about one
	 * domain whose row `by_next_check_due` says is due.
	 *
	 * Registered rather than branched on: the sweep walks a table shared by every
	 * relay kind after SES, and it asks the registry which action to schedule. That
	 * is what stops the second kind to want the sweep (the bundled plugin tier)
	 * from being a second `providerKind === '…'` line in it.
	 */
	async scheduleRelayIdentityRefresh(ctx, delayMs, domainName) {
		await ctx.scheduler.runAfter(delayMs, internal.domains.mandrillRelay.refreshIdentity, {
			domain: domainName,
		});
	},

	/**
	 * Persist the identity the lifecycle just registered. The `domainId` is
	 * resolved to the domain NAME the generic table keys on; a domain row that
	 * vanished mid-flight writes nothing rather than an orphan keyed on ''.
	 */
	async writeIdentity(ctx, domainId, identity) {
		const domainName = await resolveDomainName(ctx, domainId);
		if (domainName === null) return;
		await upsertMandrillIdentity(ctx, domainName, identity);
	},

	async clearIdentity(ctx, domainId) {
		const domainName = await resolveDomainName(ctx, domainId);
		if (domainName === null) return;
		const organizationId = await getSingletonOrganizationId(ctx);
		const existing = await loadMandrillRow(ctx, organizationId, domainName);
		if (existing) await ctx.db.delete(existing._id);
	},
};
