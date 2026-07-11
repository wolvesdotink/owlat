/**
 * Sending domain lifecycle (module) — single writer of `domains.status` and
 * its companion fields (`dnsRecords`, `verificationResults`, `verifiedAt`,
 * `lastVerifiedAt`, `lastRegistrationError`), plus the only place that
 * inserts and deletes `domains` rows.
 *
 * Four entry points:
 *   - create({domain})             — validates format + uniqueness, inserts
 *                                    the row at `'registering'`, fires
 *                                    `register_with_provider`.
 *   - transition({domainId,input}) — direct transitions for register
 *                                    completion (`registering → pending`),
 *                                    register failure (`→ failed`), and
 *                                    regenerate (`* → registering`).
 *   - recordVerification({...})    — DNS-verifier callback.
 *                                    `deriveVerificationVerdict` combines DNS
 *                                    results + per-provider check to derive
 *                                    `verified | failed | pending`, then the
 *                                    handler routes that verdict through the
 *                                    transition reducer.
 *   - remove({domainId})           — fires `delete_with_provider`, clears
 *                                    the provider identity sibling row,
 *                                    deletes the domain row, audit log.
 *
 * Effects:
 *   audit_log                       — fires on every transition + create +
 *                                     remove (skipped on verification
 *                                     self-loops to avoid spam).
 *   register_with_provider          — fires on `create()` and on
 *                                     `→ registering` (regenerate).
 *   clear_provider_identity         — fires on `→ registering` when a
 *                                     previous identity sibling row exists.
 *   delete_with_provider            — fires on `remove()`.
 *   claim_reserved_mailboxes        — fires on `→ verified`; provisions the
 *                                     mailboxes reserved on this domain pre-
 *                                     verification for already-accepted invitees.
 *
 * The lifecycle never branches on `providerType`. Provider variation lives
 * entirely behind the **Sending domain provider adapter (module)** seam —
 * see `providers/index.ts`.
 *
 * Deviations from ADR-0018: the proposed `requestVerification` entry point
 * + `run_dns_verification` effect were dropped — the DNS verifier
 * (`dnsVerification.verifyDomain`) is called directly by the FE for
 * synchronous user feedback, then calls `recordVerification` to land the
 * status transition. Re-introduce `requestVerification` when an async
 * caller (e.g., a verification cron) lands; the lifecycle is structured
 * to absorb it without surface-shape change.
 *
 * See docs/adr/0018-sending-domain-lifecycle-modules.md.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditLog, type AuditAction } from '../lib/auditLog';
import { clearReservationsForDomain } from '../mail/pendingMailbox';
import { dnsRecordsValidator, verificationResultsValidator } from '../lib/convexValidators';
import { getOptional } from '../lib/env';
import { buildDmarcRecordValue, DEFAULT_DMARC_POLICY, dmarcPolicyValidator } from './dmarc';
import {
	isSendingDomainProviderKind,
	providerFor,
	type ProviderIdentity,
	type SendingDomainProviderKind,
} from './providers';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SendingDomainStatus = 'registering' | 'pending' | 'verified' | 'failed';

type DnsRecords = Doc<'domains'>['dnsRecords'];
type VerificationResults = NonNullable<Doc<'domains'>['verificationResults']>;

/**
 * `→ pending` has two callers:
 *   - register-completion: the provider effect supplies `dnsRecords +
 *     identity` to publish; no DNS results yet.
 *   - verify-completion: the DNS verifier supplies `verificationResults`
 *     when DNS still has missing records but none failed.
 *
 * Discriminated by which sub-fields are present.
 */
export type SendingDomainTransitionInput =
	| { to: 'registering'; at: number }
	| {
			to: 'pending';
			at: number;
			/** Register-completion path. */
			dnsRecords?: DnsRecords;
			identity?: ProviderIdentity;
			/** Verify-completion path. */
			verificationResults?: VerificationResults;
	  }
	| { to: 'verified'; at: number; verificationResults: VerificationResults }
	| {
			to: 'failed';
			at: number;
			/** Set on `registering → failed`. */
			error?: string;
			/** Set on `pending|verified → failed` (verification-driven). */
			verificationResults?: VerificationResults;
	  };

export type SendingDomainTransitionOutcome =
	| {
			ok: true;
			applied: 'transitioned' | 'recorded';
			from: SendingDomainStatus;
			to: SendingDomainStatus;
			domainId: Id<'domains'>;
	  }
	| {
			ok: false;
			reason: 'domain_not_found' | 'illegal_edge';
			from?: SendingDomainStatus;
			to?: SendingDomainStatus;
	  };

export type SendingDomainCreateOutcome =
	| { ok: true; domainId: Id<'domains'> }
	| { ok: false; reason: 'invalid_format' | 'already_exists' };

export type SendingDomainRemoveOutcome = { ok: true } | { ok: false; reason: 'domain_not_found' };

// ─── Validators ─────────────────────────────────────────────────────────────

const providerIdentityValidator = v.union(
	v.object({
		kind: v.literal('mta'),
		dkimSelector: v.string(),
	}),
	v.object({
		kind: v.literal('ses'),
		dkimTokens: v.array(v.string()),
		verificationToken: v.string(),
	})
);

const transitionInputValidator = v.union(
	v.object({ to: v.literal('registering'), at: v.number() }),
	v.object({
		to: v.literal('pending'),
		at: v.number(),
		dnsRecords: v.optional(dnsRecordsValidator),
		identity: v.optional(providerIdentityValidator),
		verificationResults: v.optional(verificationResultsValidator),
	}),
	v.object({
		to: v.literal('verified'),
		at: v.number(),
		verificationResults: verificationResultsValidator,
	}),
	v.object({
		to: v.literal('failed'),
		at: v.number(),
		error: v.optional(v.string()),
		verificationResults: v.optional(verificationResultsValidator),
	})
);

const providerCheckResultValidator = v.object({
	verified: v.boolean(),
	lastError: v.optional(v.string()),
});

type ProviderCheckResult = { verified: boolean; lastError?: string };

/**
 * The verification verdict, pure. Combines DNS results + the per-provider
 * check into the `verified | failed | pending` decision the verifier callback
 * lands as a transition. Kept out of the handler so the module docstring's
 * "Reducer combines DNS results + per-provider check to derive
 * `verified | failed | pending`" invariant is true and unit-testable.
 *
 * Rules:
 *   - DKIM: every published selector must verify.
 *   - MAIL FROM: when present, every record must verify (absent ⇒ satisfied).
 *   - SPF: optional — an absent SPF record counts as verified; a present one
 *     must report `verified === true`.
 *   - DMARC: must report `verified === true`.
 *   - TLS-RPT / TLSA are deliberately NOT part of the verdict (advisory
 *     reporting / operator-owned cert lifecycle); their results are recorded
 *     for the builder UI but never gate or fail the domain.
 *
 * A domain is `verified` only when DNS is fully aligned AND the provider
 * check passes; `failed` when any authentication record failed or the
 * provider reported an error; otherwise `pending` (records still propagating,
 * none failed).
 */
export function deriveVerificationVerdict(
	dns: VerificationResults,
	providerCheck: ProviderCheckResult
): 'verified' | 'failed' | 'pending' {
	const dkimAllVerified = dns.dkim?.every((r) => r.verified) ?? false;
	const mailFromAllVerified = !dns.mailFrom || dns.mailFrom.every((r) => r.verified);
	// SPF is optional — when no SPF record is configured, it counts as verified.
	const spfVerified = dns.spf ? dns.spf.verified === true : true;
	const dnsAllVerified =
		spfVerified && dkimAllVerified && dns.dmarc?.verified === true && mailFromAllVerified;

	const dnsAnyFailed =
		dns.spf?.verified === false ||
		(dns.dkim?.some((r) => r.verified === false) ?? false) ||
		dns.dmarc?.verified === false ||
		(dns.mailFrom?.some((r) => r.verified === false) ?? false);

	const allVerified = dnsAllVerified && providerCheck.verified;
	const anyFailed = dnsAnyFailed || providerCheck.lastError !== undefined;

	if (allVerified) return 'verified';
	if (anyFailed) return 'failed';
	return 'pending';
}

// ─── Legal-edges graph ──────────────────────────────────────────────────────

const LEGAL_EDGES: Record<SendingDomainStatus, ReadonlySet<SendingDomainStatus>> = {
	registering: new Set<SendingDomainStatus>(['pending', 'failed']),
	pending: new Set<SendingDomainStatus>(['verified', 'failed', 'registering']),
	verified: new Set<SendingDomainStatus>(['registering', 'failed', 'pending']),
	failed: new Set<SendingDomainStatus>(['registering', 'verified', 'pending']),
};

// ─── Effects ────────────────────────────────────────────────────────────────

type Effect =
	| {
			kind: 'audit_log';
			action: AuditAction;
			domainId: Id<'domains'>;
			details: Record<string, string | number | boolean | null>;
	  }
	| {
			kind: 'register_with_provider';
			domainId: Id<'domains'>;
			providerType: SendingDomainProviderKind;
	  }
	| {
			kind: 'clear_provider_identity';
			domainId: Id<'domains'>;
			providerType: SendingDomainProviderKind;
	  }
	| {
			kind: 'delete_with_provider';
			domain: string;
			providerType: SendingDomainProviderKind;
	  }
	| {
			// A domain just verified — provision any mailboxes reserved on it for
			// invitees who already accepted (early-instance invites that were parked
			// in the "activates when your domain verifies" state).
			kind: 'claim_reserved_mailboxes';
			domain: string;
	  };

type ReducerResult = {
	patch: Record<string, unknown>;
	effects: Effect[];
	applied: 'transitioned' | 'recorded';
};

// ─── Reducer ────────────────────────────────────────────────────────────────

function reduce(domain: Doc<'domains'>, input: SendingDomainTransitionInput): ReducerResult {
	const from = domain.status as SendingDomainStatus;
	const to = input.to;
	const isSelfLoop = from === to;

	if (isSelfLoop) {
		return reduceSelfLoop(input);
	}

	const patch = buildPatch(domain, input);
	const effects = buildEffects(domain, input, from);
	return { patch, effects, applied: 'transitioned' };
}

function reduceSelfLoop(input: SendingDomainTransitionInput): ReducerResult {
	// Verification self-loops carry fresh results — patch them, skip audit; all
	// other self-loops are no-op records. A `verified` self-loop always patches
	// (re-verification); `pending`/`failed` self-loops patch only when they carry
	// fresh `verificationResults`. Everything else records nothing.
	const carriesResults =
		input.to === 'verified' ||
		((input.to === 'pending' || input.to === 'failed') && input.verificationResults !== undefined);

	if (carriesResults) {
		return {
			patch: {
				verificationResults: input.verificationResults,
				lastVerifiedAt: input.at,
				updatedAt: input.at,
			},
			effects: [],
			applied: 'recorded',
		};
	}
	return { patch: {}, effects: [], applied: 'recorded' };
}

function buildPatch(
	domain: Doc<'domains'>,
	input: SendingDomainTransitionInput
): Record<string, unknown> {
	const updatedAt = input.at;
	switch (input.to) {
		case 'registering':
			return {
				status: 'registering',
				dnsRecords: {},
				verificationResults: undefined,
				verifiedAt: undefined,
				lastVerifiedAt: undefined,
				lastRegistrationError: undefined,
				updatedAt,
			};

		case 'pending': {
			const patch: Record<string, unknown> = {
				status: 'pending',
				updatedAt,
				lastRegistrationError: undefined,
			};
			// Register-completion: publish fresh DNS records.
			if (input.dnsRecords !== undefined) {
				patch['dnsRecords'] = input.dnsRecords;
			}
			// Verify-completion: record results.
			if (input.verificationResults !== undefined) {
				patch['verificationResults'] = input.verificationResults;
				patch['lastVerifiedAt'] = input.at;
			}
			return patch;
		}

		case 'verified': {
			const patch: Record<string, unknown> = {
				status: 'verified',
				verificationResults: input.verificationResults,
				lastVerifiedAt: input.at,
				updatedAt,
			};
			// Preserve the first-verified timestamp — only set when never
			// previously verified.
			if (!domain.verifiedAt) {
				patch['verifiedAt'] = input.at;
			}
			return patch;
		}

		case 'failed': {
			const patch: Record<string, unknown> = {
				status: 'failed',
				updatedAt,
			};
			if (input.verificationResults !== undefined) {
				patch['verificationResults'] = input.verificationResults;
				patch['lastVerifiedAt'] = input.at;
			}
			if (input.error !== undefined) {
				patch['lastRegistrationError'] = input.error;
			}
			return patch;
		}
	}
}

function buildEffects(
	domain: Doc<'domains'>,
	input: SendingDomainTransitionInput,
	from: SendingDomainStatus
): Effect[] {
	const effects: Effect[] = [];
	const auditAction = auditActionFor(input.to, from);
	if (auditAction) {
		effects.push({
			kind: 'audit_log',
			action: auditAction,
			domainId: domain._id,
			details: buildAuditDetails(input, from),
		});
	}

	const providerKind = isSendingDomainProviderKind(domain.providerType)
		? domain.providerType
		: null;

	if (input.to === 'registering' && providerKind) {
		// Clear stale identity, then schedule a fresh register.
		effects.push({
			kind: 'clear_provider_identity',
			domainId: domain._id,
			providerType: providerKind,
		});
		effects.push({
			kind: 'register_with_provider',
			domainId: domain._id,
			providerType: providerKind,
		});
	}

	// `buildEffects` runs only for real (non-self-loop) transitions, so this fires
	// on the actual `registering|pending|failed → verified` edge — never on a
	// re-verification self-loop. Provision the mailboxes reserved on this domain
	// pre-verification for invitees who already accepted.
	if (input.to === 'verified') {
		effects.push({ kind: 'claim_reserved_mailboxes', domain: domain.domain });
	}

	return effects;
}

function auditActionFor(to: SendingDomainStatus, from: SendingDomainStatus): AuditAction | null {
	switch (to) {
		case 'registering':
			// Regenerate path — never reached via `create()` (which has its
			// own audit emit). Always means a `failed|verified|pending →
			// registering` transition.
			return 'sending_domain.regenerated';
		case 'pending':
			// `registering → pending` is the register-success edge. Any
			// other → pending (e.g. `verified → pending` because DNS broke
			// partially) is a verification-driven downgrade — audit it as
			// a verification failure (since it's not "fully verified").
			if (from === 'registering') return 'sending_domain.registered';
			return 'sending_domain.verification_failed';
		case 'verified':
			return 'sending_domain.verified';
		case 'failed':
			if (from === 'registering') return 'sending_domain.registration_failed';
			return 'sending_domain.verification_failed';
	}
}

function buildAuditDetails(
	input: SendingDomainTransitionInput,
	from: SendingDomainStatus
): Record<string, string | number | boolean | null> {
	const base: Record<string, string | number | boolean | null> = {
		previousStatus: from,
		newStatus: input.to,
		applied: 'transitioned',
	};
	if (input.to === 'failed' && input.error !== undefined) {
		base['error'] = input.error;
	}
	return base;
}

// ─── Effect runner ──────────────────────────────────────────────────────────

async function applyEffects(
	ctx: MutationCtx,
	effects: ReadonlyArray<Effect>,
	userId: string
): Promise<void> {
	for (const effect of effects) {
		switch (effect.kind) {
			case 'audit_log': {
				await recordAuditLog(ctx, {
					userId,
					action: effect.action,
					resource: 'sending_domain',
					resourceId: effect.domainId,
					details: effect.details,
				});
				break;
			}
			case 'register_with_provider': {
				await ctx.scheduler.runAfter(0, internal.domains.providers.registerAction.run, {
					providerType: effect.providerType,
					domainId: effect.domainId,
				});
				break;
			}
			case 'clear_provider_identity': {
				const adapter = providerFor(effect.providerType);
				await adapter.clearIdentity(ctx, effect.domainId);
				break;
			}
			case 'delete_with_provider': {
				await ctx.scheduler.runAfter(
					0,
					internal.domains.providers.registerAction.deleteDomainAction,
					{ providerType: effect.providerType, domain: effect.domain }
				);
				break;
			}
			case 'claim_reserved_mailboxes': {
				// Scheduled, not inline: a throw while provisioning a reserved mailbox
				// must never roll back the domain's → verified transition itself (same
				// reasoning as register_with_provider / delete_with_provider above).
				await ctx.scheduler.runAfter(
					0,
					internal.mail.pendingMailbox.provisionReservationsForVerifiedDomain,
					{ domain: effect.domain }
				);
				break;
			}
		}
	}
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

async function dispatch(
	ctx: MutationCtx,
	domain: Doc<'domains'>,
	input: SendingDomainTransitionInput,
	userId: string
): Promise<SendingDomainTransitionOutcome> {
	const from = domain.status as SendingDomainStatus;
	const isLegal = LEGAL_EDGES[from].has(input.to);
	const isSelfLoop = from === input.to;

	if (!isLegal && !isSelfLoop) {
		return { ok: false, reason: 'illegal_edge', from, to: input.to };
	}

	const result = reduce(domain, input);

	if (Object.keys(result.patch).length > 0) {
		await ctx.db.patch(domain._id, result.patch as Partial<Doc<'domains'>>);
	}

	// On register-completion `→ pending`, persist the per-provider identity
	// sibling row atomically with the status patch.
	if (input.to === 'pending' && input.identity !== undefined && !isSelfLoop) {
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

// ─── Public entry points ────────────────────────────────────────────────────

export const create = internalMutation({
	args: {
		domain: v.string(),
		userId: v.string(),
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

		const domainId = await ctx.db.insert('domains', {
			domain: normalized,
			status: 'registering',
			dnsRecords: {},
			providerType: providerKind,
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

export type SendingDomainDmarcOutcome =
	| { ok: true; policy: 'none' | 'quarantine' | 'reject'; changed: boolean }
	| { ok: false; reason: 'domain_not_found' | 'no_dmarc_record' };

/**
 * Raise (or lower) the domain's DMARC enforcement policy, plus the optional
 * RFC 7489 §6.3 enforcement knobs (`sp=` subdomain policy, `pct=` staged
 * rollout). Regenerates the `_dmarc` TXT record value from the new settings
 * and clears the stale DMARC verification result — the customer must re-publish
 * the changed record, so a previously-verified domain drops back to needing a
 * re-verify on the DMARC record only. Single writer of `domains.dmarcPolicy` +
 * `domains.dmarcSubdomainPolicy` + `domains.dmarcPct` + `dnsRecords`, per the
 * module's invariant. Does not move `domains.status`; verification is a
 * separate, explicit user action.
 *
 * Passing `undefined` for `subdomainPolicy`/`pct` clears the corresponding tag
 * (the field is removed from the row); passing a value sets it. The change is a
 * no-op only when all three settings already match what's stored.
 */
export const setDmarcPolicy = internalMutation({
	args: {
		domainId: v.id('domains'),
		policy: dmarcPolicyValidator,
		subdomainPolicy: v.optional(dmarcPolicyValidator),
		pct: v.optional(v.number()),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<SendingDomainDmarcOutcome> => {
		const domain = await ctx.db.get(args.domainId);
		if (!domain) return { ok: false, reason: 'domain_not_found' };

		const dnsRecords = domain.dnsRecords as DnsRecords;
		const dmarc = dnsRecords.dmarc;
		if (!dmarc) return { ok: false, reason: 'no_dmarc_record' };

		const currentPolicy = domain.dmarcPolicy ?? DEFAULT_DMARC_POLICY;
		const unchanged =
			currentPolicy === args.policy &&
			domain.dmarcSubdomainPolicy === args.subdomainPolicy &&
			domain.dmarcPct === args.pct;
		if (unchanged) {
			return { ok: true, policy: args.policy, changed: false };
		}

		const at = Date.now();
		// `buildDmarcRecordValue` throws on an out-of-range `pct=` (RFC 7489
		// requires an integer 0–100) — surface that to the caller rather than
		// publishing a record receivers will ignore.
		const nextValue = buildDmarcRecordValue(domain.domain, {
			policy: args.policy,
			subdomainPolicy: args.subdomainPolicy,
			pct: args.pct,
			rua: getOptional('MTA_DMARC_RUA'),
		});
		const nextDnsRecords: DnsRecords = {
			...dnsRecords,
			dmarc: { ...dmarc, value: nextValue },
		};

		// The published DMARC record now differs from what the customer has in
		// DNS — drop the stale DMARC verification result so the UI prompts a
		// re-publish + re-verify of just that record.
		const verificationResults = domain.verificationResults as VerificationResults | undefined;
		const nextVerificationResults: VerificationResults | undefined = verificationResults
			? { ...verificationResults, dmarc: undefined }
			: undefined;

		await ctx.db.patch(args.domainId, {
			dnsRecords: nextDnsRecords,
			dmarcPolicy: args.policy,
			// `undefined` removes the field from the row, clearing the tag.
			dmarcSubdomainPolicy: args.subdomainPolicy,
			dmarcPct: args.pct,
			...(nextVerificationResults !== undefined
				? { verificationResults: nextVerificationResults }
				: {}),
			updatedAt: at,
		});

		await applyEffects(
			ctx,
			[
				{
					kind: 'audit_log',
					action: 'sending_domain.dmarc_policy_changed',
					domainId: args.domainId,
					details: {
						domain: domain.domain,
						previousPolicy: currentPolicy,
						newPolicy: args.policy,
						newSubdomainPolicy: args.subdomainPolicy ?? null,
						newPct: args.pct ?? null,
						applied: 'transitioned',
					},
				},
			],
			args.userId
		);

		return { ok: true, policy: args.policy, changed: true };
	},
});

export type SendingDomainDkimRotationOutcome =
	| { ok: true; phase: 'pending' | 'activated'; selector: string; changed: boolean }
	| { ok: false; reason: 'domain_not_found' };

/**
 * MTA→Convex callback for DKIM key rotation. The MTA owns key material in
 * Redis and runs the publish-then-switch overlap workflow (RFC 6376 §3.6.1,
 * M3AAWG guidance); Convex stores the customer-facing `dnsRecords` once at
 * registration, so without this callback a rotation would leave the customer
 * looking at — and `verifyDomain` checking — the stale selector forever.
 *
 * Two phases, mirroring the MTA rotation workflow:
 *   - `'pending'`   (rotation initiated): the new selector's record is
 *                   *added* alongside the active one. Both are published in
 *                   DNS during the overlap, so the customer can publish the
 *                   new record and `verifyDomain` checks BOTH selectors. The
 *                   new record's DKIM verification result is cleared so the UI
 *                   prompts a publish + re-verify of just the new selector.
 *   - `'activated'` (signing switched): the old selector is retired and only
 *                   the new selector's record remains.
 *
 * Looks the domain up by name (the MTA only knows the domain string). A
 * domain that isn't registered with the MTA provider — or was removed — is a
 * no-op miss (`domain_not_found`); the caller logs + drops it.
 *
 * Single writer of `domains.dnsRecords.dkim` for the rotation path, per the
 * module's invariant. Does not move `domains.status`.
 */
export const recordDkimRotation = internalMutation({
	args: {
		domain: v.string(),
		selector: v.string(),
		dnsRecord: v.string(),
		phase: v.union(v.literal('pending'), v.literal('activated')),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<SendingDomainDkimRotationOutcome> => {
		const normalized = args.domain.toLowerCase();
		const domain = await ctx.db
			.query('domains')
			.withIndex('by_domain', (q) => q.eq('domain', normalized))
			.first();
		if (!domain) return { ok: false, reason: 'domain_not_found' };

		const newHost = `${args.selector}._domainkey`;
		const newRecord = { type: 'TXT' as const, host: newHost, value: args.dnsRecord };

		const dnsRecords = domain.dnsRecords as DnsRecords;
		const existingDkim = dnsRecords.dkim ?? [];

		// The new selector's host index in the existing bundle (rotation re-runs
		// or a record that drifted into the bundle already).
		const existingIndexOfNew = existingDkim.findIndex((r) => r.host === newHost);

		let nextDkim: NonNullable<DnsRecords['dkim']>;
		if (args.phase === 'pending') {
			// Overlap: keep the active selector(s), add (or refresh) the new one.
			nextDkim =
				existingIndexOfNew >= 0
					? existingDkim.map((r, i) => (i === existingIndexOfNew ? newRecord : r))
					: [...existingDkim, newRecord];
		} else {
			// Activated: retire every other selector, keep only the new one.
			nextDkim = [newRecord];
		}

		// No-op when the bundle already reads exactly as it would after the patch.
		const unchanged =
			existingDkim.length === nextDkim.length &&
			existingDkim.every(
				(r, i) =>
					r.host === nextDkim[i]!.host &&
					r.value === nextDkim[i]!.value &&
					r.type === nextDkim[i]!.type
			);
		if (unchanged) {
			return { ok: true, phase: args.phase, selector: args.selector, changed: false };
		}

		const at = Date.now();
		const nextDnsRecords: DnsRecords = { ...dnsRecords, dkim: nextDkim };

		// The published DKIM bundle now differs from what the customer has in DNS
		// — drop the stale per-selector DKIM verification results so the UI
		// prompts a re-publish + re-verify (mirrors `setDmarcPolicy`). The array
		// shape no longer aligns 1:1 with the new selector set, so clear it
		// wholesale; the next `verifyDomain` re-populates it against the new hosts.
		const verificationResults = domain.verificationResults as VerificationResults | undefined;
		const nextVerificationResults: VerificationResults | undefined = verificationResults
			? { ...verificationResults, dkim: undefined }
			: undefined;

		await ctx.db.patch(domain._id, {
			dnsRecords: nextDnsRecords,
			...(nextVerificationResults !== undefined
				? { verificationResults: nextVerificationResults }
				: {}),
			updatedAt: at,
		});

		await applyEffects(
			ctx,
			[
				{
					kind: 'audit_log',
					action: 'sending_domain.dkim_rotated',
					domainId: domain._id,
					details: {
						domain: domain.domain,
						selector: args.selector,
						phase: args.phase,
						applied: 'transitioned',
					},
				},
			],
			args.userId
		);

		return { ok: true, phase: args.phase, selector: args.selector, changed: true };
	},
});

export const remove = internalMutation({
	args: {
		domainId: v.id('domains'),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<SendingDomainRemoveOutcome> => {
		const domain = await ctx.db.get(args.domainId);
		if (!domain) return { ok: false, reason: 'domain_not_found' };

		const providerKind = isSendingDomainProviderKind(domain.providerType)
			? domain.providerType
			: null;
		const domainName = domain.domain;

		// Clear the per-provider sibling identity row (mutation context).
		if (providerKind) {
			const adapter = providerFor(providerKind);
			await adapter.clearIdentity(ctx, args.domainId);
		}

		// A removed domain will never verify, so any pre-verification mailbox
		// reservations on it would strand their invitees on "activates when your
		// domain verifies" forever. Clear them here, atomically with the removal
		// (mirrors cancelForInvitation).
		await clearReservationsForDomain(ctx, domainName);

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
		if (providerKind) {
			effects.push({
				kind: 'delete_with_provider',
				domain: domainName,
				providerType: providerKind,
			});
		}
		await applyEffects(ctx, effects, args.userId);

		return { ok: true };
	},
});
