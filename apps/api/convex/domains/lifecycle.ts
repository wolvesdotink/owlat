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

import { v, type Infer } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditLog, type AuditAction } from '../lib/auditLog';
import { defineLifecycle, refuse } from '../lib/lifecycle';
import { clearReservationsForDomain } from '../mail/pendingMailbox';
import {
	dnsRecordsValidator,
	externalReceivingProviderValidator,
	receivingModeValidator,
	verificationResultsValidator,
} from '../lib/convexValidators';
import { getOptional, getRequired } from '../lib/env';
import { normalizeReturnPathHost } from '@owlat/shared/returnPathHost';
import {
	mergeExternalReceivingSpf,
	type DomainReceivingMode,
} from '@owlat/shared/externalReceiving';
import { buildDmarcRecordValue, DEFAULT_DMARC_POLICY, dmarcPolicyValidator } from './dmarc';
import {
	buildReturnPathMailFromRecords,
	buildSpfRecordValue,
	parsePoolIps,
	parseReturnPathRelaySpfTerms,
	resolveSpfQualifier,
} from './spf';
import { buildTlsRptRecordValue, TLSRPT_HOST } from './tlsRpt';
import { buildSesMailFromRecords, resolveSesMailFrom } from './providers/ses/mailFrom';
import { mandrillIdentityValidator } from './providers/mandrill/validators';
import { logWarn } from '../lib/runtimeLog';
import {
	enabledFallbackRelayKinds,
	ensureRelayIdentities,
	relayIdentityBackfills,
} from '../lib/sendProviders/fallbackRelays';
import {
	isOwnPrimarySendingDomain,
	isSendingDomainProviderKind,
	providerFor,
	type ProviderIdentity,
	type SendingDomainProviderKind,
} from './providers';

/**
 * Synthetic `userId` tag for user-driven public-mutation transitions. The
 * lifecycle reducer recognizes internal callers by a `system:` prefix on the
 * `userId`; user-driven public mutations carry no such prefix, so they pass this
 * tag. Exported so every thin public shell over the lifecycle (`domains.ts`,
 * `returnPath.ts`) references one canonical value rather than re-declaring it.
 */
export const LIFECYCLE_USER_PUBLIC_MUTATION = 'user';

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

// Ingestion permits one row per UTC day and retains 90 days. Leave headroom
// for an in-flight cleanup, but fail the parent deletion atomically if that
// invariant is ever violated rather than orphaning telemetry.
const POSTMASTER_DOMAIN_CASCADE_LIMIT = 128;

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
	}),
	// Mandrill. State rather than key material: one shared selector, so
	// the DNS is derived from the domain name and only Mandrill's own view of
	// it is worth carrying across the action → mutation boundary. Imported
	// rather than restated — the relay sweep's store mutation validates the same
	// payload, and one of the two would eventually be the stale copy.
	mandrillIdentityValidator
);

/**
 * Compile-time completeness: every REGISTERED sending-domain provider kind must
 * have an arm above, or its `registering → pending` transition would be
 * rejected by argument validation at run time — on the provider callback, after
 * the identity was already created at the provider. Adding a provider without
 * its identity arm now fails the build instead.
 */
export type _IdentityKindsCovered =
	Exclude<SendingDomainProviderKind, Infer<typeof providerIdentityValidator>['kind']> extends never
		? true
		: never;

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
//
// The graph and the dispatcher preamble that reads it live in the generic
// lifecycle core (`lib/lifecycle.ts`, ADR-0058); the reducers, the per-provider
// identity write and the effects below stay here. `reportsTerminalRefusals` is
// off — no state is terminal (a verified domain can be re-registered, a failed
// one re-checked) and the published outcome union carries only `illegal_edge`.

const SENDING_DOMAIN_LIFECYCLE = defineLifecycle<SendingDomainStatus>({
	registering: ['pending', 'failed'],
	pending: ['verified', 'failed', 'registering'],
	verified: ['registering', 'failed', 'pending'],
	failed: ['registering', 'verified', 'pending'],
});

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
	  }
	| {
			// A domain just verified — provision any COEXISTING relay identity the
			// deployment's fallback configuration calls for (an SES or Mandrill
			// identity on a domain whose primary provider is our own MTA). Named for
			// the capability rather than for one provider, because there is more
			// than one.
			//
			// THE ID ONLY. This variant used to carry the reducer's `providerType`
			// as well, and the handler gated on it; the own-MTA-primary gate now
			// lives in `ensureRelayIdentities` and reads the DOC, so a
			// `providerType` here would be a payload nothing dereferences — read by
			// the next author as "the gate is applied at construction time", which
			// is the two-subjects-for-one-rule seam the move removed.
			kind: 'provision_relay_identity_if_enabled';
			domainId: Id<'domains'>;
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
		effects.push({ kind: 'provision_relay_identity_if_enabled', domainId: domain._id });
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
			case 'provision_relay_identity_if_enabled': {
				// THE FORWARD HALF OF A PAIR, and the pair shares ONE implementation:
				// `enabledFallbackRelayKinds` → `relayIdentityBackfills` →
				// `ensureRelayIdentities` is the whole rule, and the catch-up drain
				// (`providerRoutes.provisionDeliverabilityRelayBatch`) walks the same
				// three. Neither the "which relay" reading, nor the registry filter,
				// nor the own-MTA-primary gate is restated here — two spellings of
				// "every domain gets an identity exactly once" is how one half starts
				// provisioning a domain the other half skips, with the only symptom a
				// relay refusing a real send.
				const backfills = relayIdentityBackfills(await enabledFallbackRelayKinds(ctx));
				if (backfills.length === 0) break;
				// The doc is re-read rather than taken from the effect: the status
				// patch has already landed, and the own-MTA gate downstream reads the
				// same subject the drain reads.
				const domain = await ctx.db.get(effect.domainId);
				if (!domain) break;
				// `reprovision: true` — this edge shipped UNCONDITIONAL and stays so.
				// It fires only on a real `→ verified` transition, which an operator
				// reaches by taking the domain out of `verified` and putting it back,
				// and that deliberate act is their only lever for re-registering an
				// identity deleted or disabled at the provider while our sibling row
				// survived. The drain converges instead (`reprovision: false`); see
				// `EnsureRelayIdentityOptions`.
				//
				// Adapters SCHEDULE the provider call rather than making it, and
				// `ensureRelayIdentities` swallows a throw from any read they make
				// first: nothing in this effect may roll back the domain's → verified
				// transition (the same reasoning as `register_with_provider`).
				await ensureRelayIdentities(ctx, domain, backfills, { reprovision: true });
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
			if (providerKind !== 'mta' && providerKind !== 'ses') {
				return { ok: false, reason: 'return_path_unsupported' };
			}
			if (providerKind === 'ses' && resolveSesMailFrom(normalized, host) === null) {
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

type SendingDomainDmarcOutcome =
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

type SendingDomainReceivingOutcome =
	| { ok: true; receivingMode: DomainReceivingMode; changed: boolean }
	| { ok: false; reason: 'domain_not_found' | 'registering' };

/**
 * Switch a sending domain between "Owlat receives it" and "my existing provider
 * keeps receiving it" (send-only).
 *
 * Surgical single-record regeneration, modelled on `setDmarcPolicy` /
 * `setReturnPathHost` rather than a full `→ registering` re-registration: the
 * mode changes what two records should say, and re-registering would throw away
 * the DKIM key + reset `_dmarc` to `p=none` to achieve it.
 *
 * Two records move, and only for our OWN MTA:
 *   - apex SPF, rebuilt FROM SCRATCH (not edited in place) so switching
 *     google → microsoft drops the google include instead of accumulating both,
 *     and switching back to `'owlat'` drops them all. The rebuild reuses the
 *     registration path's builders, so the value is byte-identical to what a
 *     re-registration would have produced.
 *   - `_smtp._tls`, dropped when going external and restored when coming back.
 *
 * A RELAY-PRIMARY domain (SES, Mandrill) keeps its stored apex SPF untouched.
 * That record was generated by that provider's adapter from ITS sending hosts;
 * rebuilding it here from `MTA_SPF_INCLUDE` would authorize the wrong sender
 * entirely, and we have no safe way to regenerate the relay's own record from a
 * mutation. So the stored record is LEFT UNMERGED, and it does not carry the
 * external receiver's include even though the mode says it should. That is a
 * deliberate, conservative gap rather than a correct record: what makes it
 * acceptable is that the domain panel derives its "SPF is already merged" claim
 * from the RECORD (`externalReceivingSpfMerged`), so this domain is told, in
 * words, to add the include itself. A registration — which regenerates the
 * bundle from the adapter — folds it in at the provider-agnostic seam
 * (`providers/registerAction.ts`) for every provider, relays included.
 *
 * DKIM, DMARC and MAIL FROM are deliberately untouched: all three describe mail
 * WE send, which the inbound arrangement does not change. The bounce path is
 * likewise unaffected — a per-domain `returnPathHost` gets its MX on a SUBDOMAIN
 * (`bounce.<domain>`), so the apex MX the customer must not touch never enters
 * into it.
 *
 * Refuses outright while the domain is `registering` — see the guard in the
 * handler; the mode cannot reach a bundle that is already being generated.
 *
 * Single writer of `domains.receivingMode` + `domains.externalReceivingProvider`,
 * per the module's invariant.
 */
export const setReceivingMode = internalMutation({
	args: {
		domainId: v.id('domains'),
		mode: receivingModeValidator,
		provider: v.optional(externalReceivingProviderValidator),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<SendingDomainReceivingOutcome> => {
		const domain = await ctx.db.get(args.domainId);
		if (!domain) return { ok: false, reason: 'domain_not_found' };

		// A provider is meaningless under `'owlat'`, and keeping one would be a
		// stale answer that a later switch back to external silently reused instead
		// of asking the operator who their mail provider is now.
		const provider = args.mode === 'external' ? args.provider : undefined;
		// Absent ⇒ `'owlat'`: a pre-feature row compares equal to an explicit
		// `'owlat'` request, so re-asserting today's behaviour is a no-op rather
		// than a gratuitous drop to `pending`.
		const previousMode: DomainReceivingMode = domain.receivingMode ?? 'owlat';
		const previousProvider = domain.externalReceivingProvider;
		if (previousMode === args.mode && previousProvider === provider) {
			return { ok: true, receivingMode: args.mode, changed: false };
		}

		const at = Date.now();
		const modeFields = {
			receivingMode: args.mode,
			// `undefined` removes the field from the row.
			externalReceivingProvider: provider,
		};
		const auditDetails = (applied: string) => ({
			domain: domain.domain,
			previousMode,
			newMode: args.mode,
			previousProvider: previousProvider ?? null,
			newProvider: provider ?? null,
			applied,
		});

		// REFUSED while a registration is in flight, rather than stored and hoped for.
		//
		// Two things are impossible here at once. Patching `status: 'pending'` would
		// turn the register-completion `registering → pending` into a self-loop,
		// which `reduceSelfLoop` strips down to `verificationResults` only, dropping
		// the whole DKIM/DMARC bundle AND the provider identity row. And storing the
		// mode alone does NOT make the in-flight registration honour it:
		// `registerAction.run` reads the row ONCE and then does slow provider I/O, so
		// a mode written after that read lands on a row whose bundle was already
		// generated for the old one — an external-receiving domain left holding an
		// apex SPF with no provider include and a TLS-RPT record for an MX we do not
		// run. `setReturnPathHost` can defer to the registration because
		// `reconcileReturnPathAfterRegistration` re-reads and repairs afterwards;
		// nothing reconciles the mode, and a same-mode re-save short-circuits as
		// `changed: false`, so the divergence would never self-heal.
		//
		// Registration is seconds long and the caller is a human at a panel, so
		// "wait and try again" is the whole cost of being right. `create` is
		// unaffected: it writes the mode in the same transaction that schedules the
		// registration, so the row already carries it when the action reads it.
		if (domain.status === 'registering') {
			return { ok: false, reason: 'registering' };
		}

		const external = args.mode === 'external';
		// The sanctioned own-vs-relay predicate, not a third spelling of
		// `providerType === 'mta'`: it also admits the legacy rows that recorded no
		// kind, whose records our own MTA adapter generated. Regenerating a record
		// WE emitted is the repair side of that predicate — nothing here mints a
		// provider-side identity for a row whose provider was never recorded.
		const ownMta = isOwnPrimarySendingDomain(domain.providerType);
		const dnsRecords = domain.dnsRecords as DnsRecords;
		const nextDnsRecords: DnsRecords = { ...dnsRecords };
		let spfChanged = false;
		let tlsRptChanged = false;

		const spfInclude = getOptional('MTA_SPF_INCLUDE');
		if (ownMta && dnsRecords.spf && spfInclude) {
			const value = mergeExternalReceivingSpf(
				buildSpfRecordValue({
					include: spfInclude,
					qualifier: resolveSpfQualifier(getOptional('SPF_QUALIFIER')),
				}),
				external ? provider : undefined
			);
			if (value !== dnsRecords.spf.value) {
				nextDnsRecords.spf = { ...dnsRecords.spf, value };
				spfChanged = true;
			}
		}

		// A DANE association is stored under `tlsRpt` on rows that predate the
		// dedicated `tlsa` field (the verifier still reads it that way). Deleting
		// one here because the mode went external would silently withdraw the
		// operator's TLSA record, which has nothing to do with who receives mail.
		const tlsaStoredUnderTlsRpt = dnsRecords.tlsRpt?.type === 'TLSA';
		if (ownMta && !tlsaStoredUnderTlsRpt) {
			if (external && dnsRecords.tlsRpt) {
				delete nextDnsRecords.tlsRpt;
				tlsRptChanged = true;
			} else if (!external && !dnsRecords.tlsRpt) {
				// Restored only when the operator still has a reporting destination
				// configured; absent `MTA_TLSRPT_RUA` the record was never emitted at
				// registration either, so coming back must not invent one.
				const value = buildTlsRptRecordValue(getOptional('MTA_TLSRPT_RUA'));
				if (value) {
					nextDnsRecords.tlsRpt = { type: 'TXT', host: TLSRPT_HOST, value };
					tlsRptChanged = true;
				}
			}
		}

		const recordsChanged = spfChanged || tlsRptChanged;
		// A domain whose REGISTRATION failed keeps its `failed` status even when a
		// record moved. That row never got a bundle from the provider — it carries
		// `dnsRecords: {}` (or a fragment), no DKIM, and a `lastRegistrationError`
		// the panel shows with a "try again" path. Dropping it to `pending` would
		// claim it is merely waiting on the operator's DNS, hand them a lone
		// TLS-RPT record to publish, and hide the real problem behind a status that
		// says setup succeeded. Narrow on purpose: a `failed` row WITHOUT a
		// registration error failed VERIFICATION, which is exactly the case
		// re-publishing fixes, so that one still drops. The mode is stored either
		// way, so the retry registers with the right arrangement.
		const registrationFailed =
			domain.status === 'failed' && domain.lastRegistrationError !== undefined;
		const dropToPending = recordsChanged && !registrationFailed;

		// Only the results for the records that actually moved are dropped — the
		// customer has to re-publish those and only those (mirrors setDmarcPolicy).
		const verificationResults = domain.verificationResults as VerificationResults | undefined;
		const nextVerificationResults: VerificationResults | undefined =
			verificationResults && recordsChanged
				? {
						...verificationResults,
						...(spfChanged ? { spf: undefined } : {}),
						...(tlsRptChanged ? { tlsRpt: undefined } : {}),
					}
				: undefined;

		await ctx.db.patch(args.domainId, {
			...modeFields,
			...(recordsChanged ? { dnsRecords: nextDnsRecords } : {}),
			// Back to `pending` ONLY when a published record changed: the operator
			// now has DNS to republish, so claiming the domain is still verified
			// would be a lie. A mode flip that moved no record (no `MTA_SPF_INCLUDE`,
			// no TLS-RPT destination, a relay-primary domain) leaves a verified
			// domain verified rather than downgrading it for nothing — and a
			// registration failure outranks both (see `registrationFailed`).
			...(dropToPending ? { status: 'pending' as const } : {}),
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
					action: 'sending_domain.receiving_mode_changed',
					domainId: args.domainId,
					// Its OWN action rather than routing the status move through
					// `dispatch`: the reducer would audit a `verified → pending` edge as
					// `sending_domain.verification_failed`, and "DNS verification failed"
					// is the wrong story for an operator who deliberately changed where
					// their mail is received.
					details: auditDetails(dropToPending ? 'transitioned' : 'recorded'),
				},
			],
			args.userId
		);

		return { ok: true, receivingMode: args.mode, changed: true };
	},
});

type SendingDomainReturnPathOutcome =
	| { ok: true; returnPathHost: string; changed: boolean }
	| {
			ok: false;
			reason: 'domain_not_found' | 'unsupported_provider' | 'invalid_host' | 'host_not_subdomain';
	  };

/**
 * Build the provider-specific `mailFrom` record bundle for a custom return-path
 * host. MTA: the bounce-routing MX (EHLO_HOSTNAME) + a pool-IP SPF TXT. SES: the
 * MX + SPF TXT SES requires at the MAIL FROM subdomain. Shared by
 * `setReturnPathHost` and the post-registration reconcile so both emit
 * byte-identical records for a given host (no drift). Returns `undefined` when
 * there is nothing to publish (MTA with no pool IPs) or the SES host is not a
 * subdomain of the sending domain (already rejected upstream on the edit path).
 */
function buildReturnPathMailFrom(
	providerType: 'mta' | 'ses',
	domainName: string,
	host: string
): DnsRecords['mailFrom'] {
	if (providerType === 'mta') {
		const qualifier = resolveSpfQualifier(getOptional('SPF_QUALIFIER'));
		const poolIps = parsePoolIps(getOptional('MTA_IP_POOLS'));
		const mailHost = getOptional('EHLO_HOSTNAME')?.trim();
		if (!mailHost) {
			// A custom host with no mail host publishes an SPF-only bundle with no
			// bounce MX — warn (mirrors the registration path); DSNs can't route back.
			logWarn(
				`[MTA] return-path host ${host} set for ${domainName} but EHLO_HOSTNAME is empty — no bounce MX emitted; remote MTAs cannot deliver DSNs to bounce+…@${host}.`
			);
		}
		// The SAME bundle the registration path emits — including the relay
		// authorisation terms. A return-path EDIT that dropped them would
		// republish a record the relay is no longer covered by, silently
		// withdrawing the VERP stamp on the next verification.
		return buildReturnPathMailFromRecords(
			host,
			poolIps,
			qualifier,
			mailHost,
			parseReturnPathRelaySpfTerms(getOptional('MTA_RETURN_PATH_RELAY_SPF'))
		);
	}
	const sesMailFrom = resolveSesMailFrom(domainName, host);
	if (!sesMailFrom) return undefined;
	// `getRequired` (matching the SES registration path) so the region can never be
	// blank — a `?? ''` fallback would write a malformed MX.
	return buildSesMailFromRecords(sesMailFrom.host, getRequired('AWS_SES_REGION'));
}

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

		const providerType = domain.providerType;
		// Return-path host is honored by the built-in MTA and by SES; other
		// providers manage their own bounce path and are not supported.
		if (providerType !== 'mta' && providerType !== 'ses') {
			return { ok: false, reason: 'unsupported_provider' };
		}

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
		const sesMailFrom =
			providerType === 'ses' ? resolveSesMailFrom(domain.domain, normalized) : null;
		if (providerType === 'ses' && sesMailFrom === null) {
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
			await ctx.db.patch(args.domainId, {
				returnPathHost: normalized,
				returnPathHostSyncError: undefined,
				updatedAt: Date.now(),
			});
			await applyEffects(
				ctx,
				[
					{
						kind: 'audit_log',
						action: 'sending_domain.return_path_changed',
						domainId: args.domainId,
						details: {
							domain: domain.domain,
							previousReturnPathHost: domain.returnPathHost ?? null,
							newReturnPathHost: normalized,
							applied: 'stored_during_registration',
						},
					},
				],
				args.userId
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

		await ctx.db.patch(args.domainId, {
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
		});

		await applyEffects(
			ctx,
			[
				{
					kind: 'audit_log',
					action: 'sending_domain.return_path_changed',
					domainId: args.domainId,
					details: {
						domain: domain.domain,
						previousReturnPathHost,
						newReturnPathHost: normalized,
						applied: 'transitioned',
					},
				},
			],
			args.userId
		);

		// Reflect the new host to the provider so its bounce envelope uses it.
		// Scheduled (not inline): the DB write above must not roll back on a
		// provider hiccup, and mutations cannot run the node-runtime API clients.
		// Both reflection actions run a bounded, self-rescheduling retry; if the
		// budget is exhausted they record the failure via
		// `recordReturnPathPushResult` (audit + the `returnPathHostSyncError`
		// marker), so a permanent failure is never silent.
		if (providerType === 'mta') {
			await ctx.scheduler.runAfter(
				0,
				internal.domains.providers.registerAction.pushReturnPathHost,
				{ domainId: args.domainId, returnPathHost: normalized, attempt: 0 }
			);
		} else {
			await ctx.scheduler.runAfter(
				0,
				internal.domains.providers.registerAction.reflectSesMailFrom,
				{ domainId: args.domainId, returnPathHost: normalized, attempt: 0 }
			);
		}

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
		const providerType = domain.providerType;
		if (providerType !== 'mta' && providerType !== 'ses') return;

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

		await ctx.db.patch(args.domainId, {
			// Status is already `pending` (the transition just set it); the changed
			// mailFrom is re-verified under that same pending state.
			dnsRecords: nextDnsRecords,
			returnPathHostSyncError: undefined,
			...(nextVerificationResults !== undefined
				? { verificationResults: nextVerificationResults }
				: {}),
			updatedAt: Date.now(),
		});

		await applyEffects(
			ctx,
			[
				{
					kind: 'audit_log',
					action: 'sending_domain.return_path_changed',
					domainId: args.domainId,
					details: {
						domain: domain.domain,
						previousReturnPathHost: args.registeredReturnPathHost ?? null,
						newReturnPathHost: currentHost,
						applied: 'reconciled_after_registration',
					},
				},
			],
			args.userId
		);

		if (providerType === 'mta') {
			await ctx.scheduler.runAfter(
				0,
				internal.domains.providers.registerAction.pushReturnPathHost,
				{ domainId: args.domainId, returnPathHost: currentHost, attempt: 0 }
			);
		} else {
			await ctx.scheduler.runAfter(
				0,
				internal.domains.providers.registerAction.reflectSesMailFrom,
				{ domainId: args.domainId, returnPathHost: currentHost, attempt: 0 }
			);
		}
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
				await ctx.db.patch(args.domainId, {
					returnPathHostSyncError: undefined,
					updatedAt: Date.now(),
				});
			}
			return;
		}

		await ctx.db.patch(args.domainId, {
			returnPathHostSyncError: args.error,
			updatedAt: Date.now(),
		});

		await applyEffects(
			ctx,
			[
				{
					kind: 'audit_log',
					action: 'sending_domain.return_path_changed',
					domainId: args.domainId,
					details: {
						domain: domain.domain,
						returnPathHost: args.returnPathHost,
						applied: 'sync_failed',
						attempts: args.attempts ?? 0,
						error: args.error,
					},
				},
			],
			args.userId
		);
	},
});

type SendingDomainDkimRotationOutcome =
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
});
