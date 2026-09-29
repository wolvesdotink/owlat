/**
 * Sending domain lifecycle — per-domain VERP return-path editor.
 *
 * `setReturnPathHost` (the edit), `reconcileReturnPathAfterRegistration` (the
 * repair a registration runs after it lands) and `recordReturnPathPushResult`
 * (the provider push's terminal outcome), plus the `mailFrom` bundle builder the
 * first two share. Writes only through `patchDomainRecords` (see the module map
 * in `lifecycle.ts`).
 *
 * The provider branches (which kinds accept a host, which `mailFrom` bundle it
 * publishes, which action reflects it) live in `returnPathProviders.ts`.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { normalizeReturnPathHost } from '@owlat/shared/returnPathHost';
import { patchDomainRecords } from './lifecycle';
import type { DnsRecords, VerificationResults } from './lifecycleReducer';
import {
	buildReturnPathMailFrom,
	returnPathHostFits,
	returnPathProviderKind,
	scheduleReturnPathReflection,
} from './returnPathProviders';

type SendingDomainReturnPathOutcome =
	| { ok: true; returnPathHost: string; changed: boolean }
	| {
			ok: false;
			reason: 'domain_not_found' | 'unsupported_provider' | 'invalid_host' | 'host_not_subdomain';
	  };

/**
 * Set (or change) the domain's per-domain VERP return-path host.
 *
 * Regenerates the `mailFrom` SPF record on the new host and clears the stale
 * MAIL FROM verification result — the customer must publish the record at the
 * new host, so the domain drops to `pending` awaiting a re-verify. Mirrors
 * `setDmarcPolicy`'s surgical single-record regeneration rather than a full
 * `→ registering` re-registration, which would needlessly reset the DKIM/DMARC
 * records (the provider rebuilds `_dmarc` at `p=none`).
 *
 * The provider must ALSO learn the new host so its bounce envelope uses it:
 *   - MTA: reflected out-of-band via the scheduled `pushReturnPathHost` action —
 *     the register endpoint is idempotent for the DKIM key, so this touches
 *     only the return-path host, never the signing key.
 *   - SES: reflected via `reflectSesMailFrom`, which calls SES's
 *     `SetIdentityMailFromDomain`. SES's custom MAIL FROM must be a *subdomain of
 *     the sending domain*, so an out-of-zone/apex host is rejected
 *     (`host_not_subdomain`); the regenerated records are SES's MX + SPF TXT
 *     shape, not the MTA's pool-IP SPF.
 *
 * Any other provider is `unsupported_provider`. The host is validated by the
 * SHARED strict return-path validator (packages/shared `normalizeReturnPathHost`,
 * the exact validator the MTA applies) — NOT `asDnsName`, which is laxer and
 * would let Convex commit a host (single label, `_service` label) the MTA then
 * 400s forever. Single writer of `domains.returnPathHost`.
 */
export const setReturnPathHost = internalMutation({
	args: {
		domainId: v.id('domains'),
		returnPathHost: v.string(),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<SendingDomainReturnPathOutcome> => {
		const domain = await ctx.db.get(args.domainId);
		if (!domain) return { ok: false, reason: 'domain_not_found' };

		// Return-path host is honored by the built-in MTA and by SES; other
		// providers manage their own bounce path and are not supported.
		const providerType = returnPathProviderKind(domain.providerType);
		if (providerType === null) return { ok: false, reason: 'unsupported_provider' };

		// Validate + normalize via the SHARED strict validator (identical to the
		// MTA's acceptance gate) so Convex never persists a host the MTA rejects.
		const normalized = normalizeReturnPathHost(args.returnPathHost);
		if (normalized === null) return { ok: false, reason: 'invalid_host' };

		if (domain.returnPathHost === normalized) {
			return { ok: true, returnPathHost: normalized, changed: false };
		}

		// SES requires its custom MAIL FROM to be a subdomain of the sending domain.
		// Validate that on EVERY path (including the registering short-circuit
		// below) so a bad SES host is rejected up front, never stored + then failing
		// registration.
		if (!returnPathHostFits(providerType, domain.domain, normalized)) {
			return { ok: false, reason: 'host_not_subdomain' };
		}

		// FINDING 1 (edit path) — a registration is in flight (create or
		// `regenerateDnsRecords` left the domain `registering`). Patching
		// `status: 'pending'` here would turn the register-completion callback
		// (`registering → pending`) into a `pending → pending` self-loop, which
		// `reduceSelfLoop` strips down to `verificationResults` only — silently
		// dropping the DKIM/DMARC bundle AND the provider identity row. So we do NOT
		// touch status / records / verification and do NOT schedule a reflection:
		// we only store the new host (+ clear the sync marker). The in-flight
		// registration reads `returnPathHost` and carries the FULL bundle — with the
		// custom mailFrom — onto the already-updated host, and reflects it to the
		// provider itself. If registration had ALREADY read the OLD host before this
		// store, its records/provider land on the old host while the row now leads
		// with the new one; `reconcileReturnPathAfterRegistration` (run by the
		// registration action right after its transition, serializable with this
		// mutation) detects that divergence and regenerates the records + reflects the
		// current host. A plain same-host re-save would short-circuit above, so that
		// reconcile — not "the next edit" — is what closes the window.
		if (domain.status === 'registering') {
			await patchDomainRecords(
				ctx,
				domain,
				{
					returnPathHost: normalized,
					returnPathHostSyncError: undefined,
					updatedAt: Date.now(),
				},
				{
					userId: args.userId,
					action: 'sending_domain.return_path_changed',
					details: {
						domain: domain.domain,
						previousReturnPathHost: domain.returnPathHost ?? null,
						newReturnPathHost: normalized,
						applied: 'stored_during_registration',
					},
				}
			);
			return { ok: true, returnPathHost: normalized, changed: true };
		}

		// Regenerate the provider-specific `mailFrom` record(s) on the new host (the
		// shared builder keeps this byte-identical to the post-registration reconcile
		// and registration paths).
		const mailFromRecords = buildReturnPathMailFrom(providerType, domain.domain, normalized);

		const at = Date.now();

		const dnsRecords = domain.dnsRecords as DnsRecords;
		const nextDnsRecords: DnsRecords = { ...dnsRecords };
		if (mailFromRecords) {
			nextDnsRecords.mailFrom = mailFromRecords;
		} else {
			// No records to publish (MTA with no pool IPs) → drop any stale entry.
			delete nextDnsRecords.mailFrom;
		}

		// The published MAIL FROM record now differs from what the customer has in
		// DNS — drop the stale MAIL FROM verification result so the UI prompts a
		// re-publish + re-verify of just that record (mirrors setDmarcPolicy).
		const verificationResults = domain.verificationResults as VerificationResults | undefined;
		const nextVerificationResults: VerificationResults | undefined = verificationResults
			? { ...verificationResults, mailFrom: undefined }
			: undefined;

		const previousReturnPathHost = domain.returnPathHost ?? null;

		await patchDomainRecords(
			ctx,
			domain,
			{
				returnPathHost: normalized,
				dnsRecords: nextDnsRecords,
				// A changed return-path host means the domain is no longer fully
				// verified until the new record is published + checked.
				status: 'pending',
				// Clear any stale sync-failure marker from a previous host: this edit
				// schedules a fresh push, so the prior divergence is being resolved.
				returnPathHostSyncError: undefined,
				...(nextVerificationResults !== undefined
					? { verificationResults: nextVerificationResults }
					: {}),
				updatedAt: at,
			},
			{
				userId: args.userId,
				action: 'sending_domain.return_path_changed',
				details: {
					domain: domain.domain,
					previousReturnPathHost,
					newReturnPathHost: normalized,
					applied: 'transitioned',
				},
			}
		);

		// Reflect the new host to the provider so its bounce envelope uses it
		// (scheduled; see `scheduleReturnPathReflection`).
		await scheduleReturnPathReflection(ctx, providerType, args.domainId, normalized);

		return { ok: true, returnPathHost: normalized, changed: true };
	},
});

/**
 * Reconcile the return-path records after a registration completes.
 *
 * `registerAction.run` reads `returnPathHost` ONCE, then builds the DNS bundle +
 * reflects that host to the provider over slow external I/O, then transitions the
 * domain to `pending`. A return-path edit that commits DURING that window hits
 * the `registering` guard in `setReturnPathHost`, which stores the new host but
 * defers records/reflection to registration — so registration lands records (and
 * a provider reflection) for the OLD host while the row now stores the NEW one.
 * DB `mailFrom`, the provider, and `returnPathHost` diverge, and a same-host
 * re-save short-circuits (`changed: false`), so nothing self-heals.
 *
 * The registration action calls this as a MUTATION right after its transition —
 * serializable with `setReturnPathHost`, so it observes the committed host with
 * no TOCTOU. If the stored host differs from the one registration built records
 * for, it regenerates the `mailFrom` records for the CURRENT host and schedules a
 * reflection, converging records + provider onto the stored host. (A yet-later
 * edit runs on a `pending` domain and self-heals via the normal edit path.)
 */
export const reconcileReturnPathAfterRegistration = internalMutation({
	args: {
		domainId: v.id('domains'),
		registeredReturnPathHost: v.optional(v.string()),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<void> => {
		const domain = await ctx.db.get(args.domainId);
		if (!domain) return;
		const providerType = returnPathProviderKind(domain.providerType);
		if (providerType === null) return;

		const currentHost = domain.returnPathHost;
		// No divergence — registration built records for the host still stored.
		if (currentHost === args.registeredReturnPathHost) return;
		// The host was cleared mid-registration (no clear path exists today, but stay
		// safe): nothing concrete to reflect, leave the registered records in place.
		if (currentHost === undefined) return;

		const mailFromRecords = buildReturnPathMailFrom(providerType, domain.domain, currentHost);
		const dnsRecords = domain.dnsRecords as DnsRecords;
		const nextDnsRecords: DnsRecords = { ...dnsRecords };
		if (mailFromRecords) {
			nextDnsRecords.mailFrom = mailFromRecords;
		} else {
			delete nextDnsRecords.mailFrom;
		}

		// The published MAIL FROM record changed under the customer — drop its stale
		// verification result so the UI prompts a re-publish of just that record.
		const verificationResults = domain.verificationResults as VerificationResults | undefined;
		const nextVerificationResults: VerificationResults | undefined = verificationResults
			? { ...verificationResults, mailFrom: undefined }
			: undefined;

		await patchDomainRecords(
			ctx,
			domain,
			{
				// Status is already `pending` (the transition just set it); the changed
				// mailFrom is re-verified under that same pending state.
				dnsRecords: nextDnsRecords,
				returnPathHostSyncError: undefined,
				...(nextVerificationResults !== undefined
					? { verificationResults: nextVerificationResults }
					: {}),
				updatedAt: Date.now(),
			},
			{
				userId: args.userId,
				action: 'sending_domain.return_path_changed',
				details: {
					domain: domain.domain,
					previousReturnPathHost: args.registeredReturnPathHost ?? null,
					newReturnPathHost: currentHost,
					applied: 'reconciled_after_registration',
				},
			}
		);

		await scheduleReturnPathReflection(ctx, providerType, args.domainId, currentHost);
	},
});

/**
 * Record the terminal outcome of a `pushReturnPathHost` attempt chain.
 *
 * Called by the push action (which, as a node action, cannot touch the DB):
 *   - success → clears any `returnPathHostSyncError` marker (idempotent).
 *   - give-up (retry budget exhausted) → sets the marker to the last error AND
 *     audits the give-up, so the Convex↔MTA divergence is visible rather than
 *     silent.
 *
 * Guards against a stale write: if the domain's `returnPathHost` has since
 * changed (a newer edit superseded this chain), the result is dropped so an old
 * failure cannot mark a domain that has already moved on.
 */
export const recordReturnPathPushResult = internalMutation({
	args: {
		domainId: v.id('domains'),
		returnPathHost: v.string(),
		error: v.optional(v.string()),
		attempts: v.optional(v.number()),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<void> => {
		const domain = await ctx.db.get(args.domainId);
		if (!domain) return;
		// A newer edit changed the target host — this result is stale, ignore it.
		if (domain.returnPathHost !== args.returnPathHost) return;

		if (args.error === undefined) {
			// Success: clear the marker if one was set. No-op / no audit otherwise.
			if (domain.returnPathHostSyncError !== undefined) {
				await patchDomainRecords(ctx, domain, {
					returnPathHostSyncError: undefined,
					updatedAt: Date.now(),
				});
			}
			return;
		}

		await patchDomainRecords(
			ctx,
			domain,
			{
				returnPathHostSyncError: args.error,
				updatedAt: Date.now(),
			},
			{
				userId: args.userId,
				action: 'sending_domain.return_path_changed',
				details: {
					domain: domain.domain,
					returnPathHost: args.returnPathHost,
					applied: 'sync_failed',
					attempts: args.attempts ?? 0,
					error: args.error,
				},
			}
		);
	},
});
