/**
 * Mandrill (Mailchimp Transactional) sending domain provider adapter.
 *
 * Owns the Mandrill-side surface of one **Sending domain** — the provider API
 * calls (`registerDomain`, `runProviderCheck`) and the rows this kind keeps in
 * the GENERIC `sendingDomainRelayIdentities` table (plan D7: the per-provider
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
 * Per ADR-0018, extended by plan D6/D7.
 */

import { logError } from '../../../lib/runtimeLog';
import { getSingletonOrganizationId } from '../../../lib/sessionOrganization';
import { addSenderDomain, checkSenderDomain } from './api';
import { buildMandrillIdentity, describeMandrillIdentity } from './identity';
import { loadMandrillRow, resolveDomainName, upsertMandrillIdentity } from './persistence';
import { buildMandrillDnsRecords } from './records';
import { mandrillReferenceArm, mandrillRelayDomainVerified } from './relayVerification';
import type { ProviderCheckResult, SendingDomainProviderModule } from '../types';

export const mandrillProvider: SendingDomainProviderModule<'mandrill'> = {
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

	// The relay-verification read seam (D6) and the alignment pre-flight's
	// second arm (P3.1) — both pure reads of the identity row; see
	// `./relayVerification.ts`.
	relayDomainVerified: mandrillRelayDomainVerified,
	describeReferenceArm: mandrillReferenceArm,

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
