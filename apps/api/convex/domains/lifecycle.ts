/**
 * Sending domain lifecycle (module) — single writer of `domains` rows (ADR-0018).
 *
 * Owns `domains.status` and its companion fields (`dnsRecords`,
 * `verificationResults`, `verifiedAt`, `lastVerifiedAt`,
 * `lastRegistrationError`), and is the only place that inserts and deletes
 * `domains` rows. Split across five files that share that one write path:
 *
 *   lifecycleReducer.ts  — pure: types, validators, the verification verdict,
 *                          the legal-edges graph and the reducer.
 *   lifecycleEffects.ts  — the effect runner (`applyEffects`).
 *   lifecycle.ts (here)  — `dispatch`, the status entry points, and
 *                          `patchDomainRecords`, the write every feature editor
 *                          goes through.
 *   lifecycleDmarc.ts, lifecycleReceiving.ts, lifecycleReturnPath.ts,
 *   lifecycleDkim.ts     — the feature editors (below).
 *
 * Entry points (all internal mutations):
 *   lifecycle.create                     — validates format + uniqueness,
 *                                          inserts at `'registering'`, fires
 *                                          `register_with_provider`.
 *   lifecycle.transition                 — register completion
 *                                          (`registering → pending`), register
 *                                          failure (`→ failed`), regenerate
 *                                          (`* → registering`).
 *   lifecycle.recordVerification         — DNS-verifier callback;
 *                                          `deriveVerificationVerdict` picks
 *                                          `verified | failed | pending` and the
 *                                          reducer lands it.
 *   lifecycle.remove                     — clears identity sibling rows,
 *                                          deletes the row, fires
 *                                          `delete_with_provider`.
 *   lifecycleDmarc.setDmarcPolicy        — regenerates `_dmarc`.
 *   lifecycleReceiving.setReceivingMode  — apex SPF + `_smtp._tls` for the
 *                                          inbound arrangement.
 *   lifecycleReturnPath.setReturnPathHost,
 *     .reconcileReturnPathAfterRegistration,
 *     .recordReturnPathPushResult        — the per-domain VERP return path.
 *   lifecycleDkim.recordDkimRotation     — MTA DKIM rotation callback.
 *
 * The editors never go through the reducer: each regenerates the one record it
 * owns and writes it with `patchDomainRecords`, under its own audit action.
 * `setReceivingMode` and `setReturnPathHost` also drop a verified domain back to
 * `pending` that way, because the reducer would audit that edge as a failed
 * verification. The single-writer rule is held by
 * `__tests__/domainsSingleWriter.test.ts`.
 *
 * The status machine never branches on `providerType`; provider variation lives
 * behind the **Sending domain provider adapter (module)** seam
 * (`providers/index.ts`). The return-path family is the exception; its kind
 * branches are confined to `returnPathProviders.ts`.
 *
 * Deviation from ADR-0018: there is no `requestVerification` entry point. The
 * FE calls the DNS verifier (`dnsVerification.verifyDomain`) directly for
 * synchronous feedback, and it lands the result through `recordVerification`.
 */

import { v } from 'convex/values';
import type { WithoutSystemFields } from 'convex/server';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { AuditAction } from '../lib/auditLog';
import { refuse } from '../lib/lifecycle';
import { clearReservationsForDomain } from '../mail/pendingMailbox';
import {
	externalReceivingProviderValidator,
	receivingModeValidator,
	verificationResultsValidator,
} from '../lib/convexValidators';
import { getOptional } from '../lib/env';
import { normalizeReturnPathHost } from '@owlat/shared/returnPathHost';
import {
	isSendingDomainProviderKind,
	providerFor,
	type SendingDomainProviderKind,
} from './providers';
import {
	deriveVerificationVerdict,
	providerCheckResultValidator,
	reduce,
	SENDING_DOMAIN_LIFECYCLE,
	transitionInputValidator,
	type Effect,
	type SendingDomainStatus,
	type SendingDomainTransitionInput,
	type SendingDomainTransitionOutcome,
} from './lifecycleReducer';
import { applyEffects } from './lifecycleEffects';
import { returnPathHostFits, returnPathProviderKind } from './returnPathProviders';

/**
 * Synthetic `userId` tag for user-driven public-mutation transitions. The
 * lifecycle reducer recognizes internal callers by a `system:` prefix on the
 * `userId`; user-driven public mutations carry no such prefix, so they pass this
 * tag. Exported so every thin public shell over the lifecycle (`domains.ts`,
 * `returnPath.ts`) references one canonical value rather than re-declaring it.
 */
export const LIFECYCLE_USER_PUBLIC_MUTATION = 'user';

type SendingDomainCreateOutcome =
	| { ok: true; domainId: Id<'domains'> }
	| {
			ok: false;
			reason:
				| 'invalid_format'
				| 'already_exists'
				| 'invalid_return_path_host'
				| 'return_path_unsupported'
				| 'return_path_not_subdomain';
	  };

type SendingDomainRemoveOutcome = { ok: true } | { ok: false; reason: 'domain_not_found' };
type RemoveArgs = { domainId: Id<'domains'>; userId: string };

// Ingestion permits one row per UTC day and retains 90 days. Leave headroom
// for an in-flight cleanup, but fail the parent deletion atomically if that
// invariant is ever violated rather than orphaning telemetry.
const POSTMASTER_DOMAIN_CASCADE_LIMIT = 128;

// ─── Dispatcher ─────────────────────────────────────────────────────────────

async function dispatch(
	ctx: MutationCtx,
	domain: Doc<'domains'>,
	input: SendingDomainTransitionInput,
	userId: string
): Promise<SendingDomainTransitionOutcome> {
	const from = domain.status as SendingDomainStatus;
	const verdict = SENDING_DOMAIN_LIFECYCLE.classify(from, input.to);

	if (verdict.kind === 'refused') {
		return refuse(verdict);
	}

	const result = reduce(domain, input);

	if (Object.keys(result.patch).length > 0) {
		await ctx.db.patch(domain._id, result.patch as Partial<Doc<'domains'>>);
	}

	// On register-completion `→ pending`, persist the per-provider identity
	// sibling row atomically with the status patch.
	if (input.to === 'pending' && input.identity !== undefined && !verdict.isSelfLoop) {
		const providerKind = isSendingDomainProviderKind(domain.providerType)
			? domain.providerType
			: null;
		if (providerKind && input.identity.kind === providerKind) {
			const adapter = providerFor(providerKind);
			await adapter.writeIdentity(ctx, domain._id, input.identity);
		}
	}

	await applyEffects(ctx, result.effects, userId);

	return {
		ok: true,
		applied: result.applied,
		from,
		to: input.to,
		domainId: domain._id,
	};
}

// ─── The editors' write ─────────────────────────────────────────────────────

export type DomainRecordsPatch = Partial<WithoutSystemFields<Doc<'domains'>>>;

export type DomainRecordsAudit = {
	userId: string;
	action: AuditAction;
	details: Record<string, string | number | boolean | null>;
};

/**
 * The one `domains` patch outside `dispatch`. Every feature editor
 * (`lifecycleDmarc`, `lifecycleReceiving`, `lifecycleReturnPath`,
 * `lifecycleDkim`) patches its fields through here, and the audit entry, when
 * given, runs through the same effect runner as the status machine's, so it
 * lands after the patch under `resource: 'sending_domain'`.
 */
export async function patchDomainRecords(
	ctx: MutationCtx,
	domain: Doc<'domains'>,
	patch: DomainRecordsPatch,
	audit?: DomainRecordsAudit
): Promise<void> {
	await ctx.db.patch(domain._id, patch);
	if (!audit) return;
	await applyEffects(
		ctx,
		[{ kind: 'audit_log', action: audit.action, domainId: domain._id, details: audit.details }],
		audit.userId
	);
}

// ─── Public entry points ────────────────────────────────────────────────────

export const create = internalMutation({
	args: {
		domain: v.string(),
		userId: v.string(),
		// Optional per-domain VERP return-path host, set ATOMICALLY with creation
		// rather than by a follow-up write. Threading it here — rather than a second
		// `setReturnPathHost`
		// write after `create` — means the row already carries the host when the
		// register-completion `→ pending` transition lands, so that transition is a
		// real edge (not a `pending → pending` self-loop that would drop the DKIM/
		// DMARC bundle + provider identity if it raced a separate status patch).
		returnPathHost: v.optional(v.string()),
		// The domain's inbound-mail arrangement, stored ATOMICALLY with the insert
		// for exactly the `returnPathHost` reason above: `register_with_provider`
		// is scheduled from this same mutation and reads the row ONCE, before its
		// slow provider I/O, so the mode has to be on the row already or the very
		// first record bundle is generated for the wrong arrangement (apex SPF
		// without the customer's provider include, plus a TLS-RPT record for an MX
		// we do not run). This is the whole reason `setReceivingMode` REFUSES to
		// run mid-registration and `create` does not have to. Absent ⇒ `'owlat'`;
		// nothing is written and the row is indistinguishable from a pre-feature one.
		receivingMode: v.optional(receivingModeValidator),
		externalReceivingProvider: v.optional(externalReceivingProviderValidator),
	},
	handler: async (ctx, args): Promise<SendingDomainCreateOutcome> => {
		const domainRegex = /^(?!-)[A-Za-z0-9-]+([-.][A-Za-z0-9]+)*\.[A-Za-z]{2,}$/;
		if (!domainRegex.test(args.domain)) {
			return { ok: false, reason: 'invalid_format' };
		}

		const normalized = args.domain.toLowerCase();

		const existing = await ctx.db
			.query('domains')
			.withIndex('by_domain', (q) => q.eq('domain', normalized))
			.first();
		if (existing) {
			return { ok: false, reason: 'already_exists' };
		}

		const now = Date.now();
		const envProvider = getOptional('EMAIL_PROVIDER') ?? 'mta';
		const providerKind: SendingDomainProviderKind = isSendingDomainProviderKind(envProvider)
			? envProvider
			: 'mta';

		// Validate the optional return-path host up front, mirroring
		// `setReturnPathHost` exactly (shared strict validator; MTA/SES only; SES
		// requires a subdomain of the sending domain) so a bad host fails create
		// cleanly rather than after the row + registration are scheduled.
		let returnPathHost: string | undefined;
		if (args.returnPathHost !== undefined) {
			const host = normalizeReturnPathHost(args.returnPathHost);
			if (host === null) return { ok: false, reason: 'invalid_return_path_host' };
			const returnPathKind = returnPathProviderKind(providerKind);
			if (returnPathKind === null) return { ok: false, reason: 'return_path_unsupported' };
			if (!returnPathHostFits(returnPathKind, normalized, host)) {
				return { ok: false, reason: 'return_path_not_subdomain' };
			}
			returnPathHost = host;
		}

		// `'owlat'` carries no provider — see `setReceivingMode`, which clears the
		// field for the same reason: a provider left behind on an owlat-receiving
		// row is a stale answer the next switch to external would silently reuse.
		const externalReceivingProvider =
			args.receivingMode === 'external' ? args.externalReceivingProvider : undefined;

		const domainId = await ctx.db.insert('domains', {
			domain: normalized,
			status: 'registering',
			dnsRecords: {},
			providerType: providerKind,
			...(returnPathHost ? { returnPathHost } : {}),
			// Written only when asked for, so an unset mode stays ABSENT on the row
			// rather than being materialised as an explicit `'owlat'`.
			...(args.receivingMode ? { receivingMode: args.receivingMode } : {}),
			...(externalReceivingProvider ? { externalReceivingProvider } : {}),
			createdAt: now,
			updatedAt: now,
		});

		await applyEffects(
			ctx,
			[
				{
					kind: 'audit_log',
					action: 'sending_domain.created',
					domainId,
					details: {
						domain: normalized,
						providerType: providerKind,
						applied: 'transitioned',
					},
				},
				{
					kind: 'register_with_provider',
					domainId,
					providerType: providerKind,
				},
			],
			args.userId
		);

		return { ok: true, domainId };
	},
});

export const transition = internalMutation({
	args: {
		domainId: v.id('domains'),
		input: transitionInputValidator,
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<SendingDomainTransitionOutcome> => {
		const domain = await ctx.db.get(args.domainId);
		if (!domain) return { ok: false, reason: 'domain_not_found' };
		return await dispatch(ctx, domain, args.input, args.userId);
	},
});

/**
 * DNS-verifier callback. Derives the verdict via `deriveVerificationVerdict`
 * (DNS results + per-provider check → `verified | failed | pending`) and
 * applies the matching transition. The reducer never branches on
 * `providerType` — the provider check is delivered as `{ verified, lastError? }`.
 */
export const recordVerification = internalMutation({
	args: {
		domainId: v.id('domains'),
		verificationResults: verificationResultsValidator,
		providerCheck: providerCheckResultValidator,
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<SendingDomainTransitionOutcome> => {
		const domain = await ctx.db.get(args.domainId);
		if (!domain) return { ok: false, reason: 'domain_not_found' };

		const dns = args.verificationResults;

		// TLS-RPT (`_smtp._tls`) / TLSA are deliberately NOT part of the verdict:
		// TLS-RPT is advisory failure reporting and TLSA depends on the operator's
		// own certificate lifecycle, so neither should gate (or fail) a sending
		// domain's deliverability the way authentication alignment does. Their
		// `dns.tlsRpt` result is still recorded for the builder UI.
		const verdict = deriveVerificationVerdict(dns, args.providerCheck);

		const at = Date.now();

		let input: SendingDomainTransitionInput;
		if (verdict === 'verified') {
			input = { to: 'verified', at, verificationResults: dns };
		} else if (verdict === 'failed') {
			input = { to: 'failed', at, verificationResults: dns };
		} else {
			// Some records still pending, none failed — land at `pending`
			// with fresh results.
			input = { to: 'pending', at, verificationResults: dns };
		}

		return await dispatch(ctx, domain, input, args.userId);
	},
});

// Exported so the workspace deletion's `domains` step runs it inline on the
// deletion worker's context; via `runMutation` the fence would refuse it.
export const removeSendingDomain = {
	args: { domainId: v.id('domains'), userId: v.string() },
	handler: async (ctx: MutationCtx, args: RemoveArgs): Promise<SendingDomainRemoveOutcome> => {
		const domain = await ctx.db.get(args.domainId);
		if (!domain) return { ok: false, reason: 'domain_not_found' };

		const providerKind = isSendingDomainProviderKind(domain.providerType)
			? domain.providerType
			: null;
		const domainName = domain.domain;
		const cleanupProviders = new Set<SendingDomainProviderKind>();
		if (providerKind) cleanupProviders.add(providerKind);
		const [mtaIdentity, sesIdentity] = await Promise.all([
			ctx.db
				.query('sendingDomainMtaIdentities')
				.withIndex('by_domain', (q) => q.eq('domainId', args.domainId))
				.first(),
			ctx.db
				.query('sendingDomainSesIdentities')
				.withIndex('by_domain', (q) => q.eq('domainId', args.domainId))
				.first(),
		]);
		if (mtaIdentity) cleanupProviders.add('mta');
		if (sesIdentity) cleanupProviders.add('ses');

		// Hybrid MTA+SES routing owns two external identities and two sibling rows.
		for (const kind of cleanupProviders) {
			const adapter = providerFor(kind);
			await adapter.clearIdentity(ctx, args.domainId);
		}

		// A removed domain will never verify, so any pre-verification mailbox
		// reservations on it would strand their invitees on "activates when your
		// domain verifies" forever. Clear them here, atomically with the removal
		// (mirrors cancelForInvitation).
		await clearReservationsForDomain(ctx, domainName);

		const postmasterRows = await ctx.db
			.query('googlePostmasterStats')
			.withIndex('by_domain_id', (q) => q.eq('domainId', args.domainId))
			.take(POSTMASTER_DOMAIN_CASCADE_LIMIT + 1);
		if (postmasterRows.length > POSTMASTER_DOMAIN_CASCADE_LIMIT) {
			throw new Error('Postmaster domain cascade exceeded its bounded invariant');
		}
		for (const row of postmasterRows) await ctx.db.delete(row._id);

		// Delete the row; provider-side cleanup is best-effort + async.
		await ctx.db.delete(args.domainId);

		const effects: Effect[] = [
			{
				kind: 'audit_log',
				action: 'sending_domain.deleted',
				domainId: args.domainId,
				details: {
					domain: domainName,
					applied: 'transitioned',
				},
			},
		];
		for (const kind of cleanupProviders) {
			effects.push({
				kind: 'delete_with_provider',
				domain: domainName,
				providerType: kind,
			});
		}
		await applyEffects(ctx, effects, args.userId);

		return { ok: true };
	},
};

export const remove = internalMutation(removeSendingDomain);

// ============== v0.6.3 compatibility shims — remove after release N+1 ==============
//
// v0.6.3 called these three editors at `domains/lifecycle` from actions: the
// registration and return-path push actions (`providers/registerAction.ts`) and
// the webhook dispatcher. An action running when this release deploys finishes
// on v0.6.3's code, but each ctx.runMutation it makes resolves against the NEW
// deployment (CONVENTIONS.md, "Old clients and workers against new functions").
// So they stay for one release at their old path with their old arguments and
// result, delegating to the editor's new home. The public mutations that call
// the other editors run in one transaction and need no shim.

/** Remove after release N+1: v0.6.3 compatibility (see the section comment above). */
export const reconcileReturnPathAfterRegistration = internalMutation({
	args: {
		domainId: v.id('domains'),
		registeredReturnPathHost: v.optional(v.string()),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<void> => {
		await ctx.runMutation(
			internal.domains.lifecycleReturnPath.reconcileReturnPathAfterRegistration,
			args
		);
	},
});

/** Remove after release N+1: v0.6.3 compatibility (see the section comment above). */
export const recordReturnPathPushResult = internalMutation({
	args: {
		domainId: v.id('domains'),
		returnPathHost: v.string(),
		error: v.optional(v.string()),
		attempts: v.optional(v.number()),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<void> => {
		await ctx.runMutation(internal.domains.lifecycleReturnPath.recordReturnPathPushResult, args);
	},
});

/** Remove after release N+1: v0.6.3 compatibility (see the section comment above). */
export const recordDkimRotation = internalMutation({
	args: {
		domain: v.string(),
		selector: v.string(),
		dnsRecord: v.string(),
		phase: v.union(v.literal('pending'), v.literal('activated')),
		userId: v.string(),
	},
	handler: async (
		ctx,
		args
	): Promise<
		| { ok: true; phase: 'pending' | 'activated'; selector: string; changed: boolean }
		| { ok: false; reason: 'domain_not_found' }
	> => await ctx.runMutation(internal.domains.lifecycleDkim.recordDkimRotation, args),
});
