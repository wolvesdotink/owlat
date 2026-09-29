/**
 * Sending domain lifecycle — the pure half (ADR-0018).
 *
 * Everything here decides; nothing here writes. The status and transition
 * types, the argument validators the lifecycle's entry points share, the
 * verification verdict, the legal-edges graph, and the reducer that turns a
 * transition into `{ patch, effects, applied }`. `lifecycle.ts` owns the only
 * code that applies that result to the database (`dispatch`), and
 * `lifecycleEffects.ts` runs the effects; the feature editors (`lifecycleDmarc.ts`,
 * `lifecycleReceiving.ts`, `lifecycleReturnPath.ts`, `lifecycleDkim.ts`) import
 * the record types from here and write through `patchDomainRecords`.
 *
 * Kept free of `ctx` so the reducer and the verdict can be unit-tested without
 * a database, and so the status machine reads in one place.
 */

import { v, type Infer } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { AuditAction } from '../lib/auditLog';
import { defineLifecycle } from '../lib/lifecycle';
import { dnsRecordsValidator, verificationResultsValidator } from '../lib/convexValidators';
import { mandrillIdentityValidator } from './providers/mandrill/validators';
import {
	isSendingDomainProviderKind,
	type ProviderIdentity,
	type SendingDomainProviderKind,
} from './providers';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SendingDomainStatus = 'registering' | 'pending' | 'verified' | 'failed';

export type DnsRecords = Doc<'domains'>['dnsRecords'];
export type VerificationResults = NonNullable<Doc<'domains'>['verificationResults']>;

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

export const transitionInputValidator = v.union(
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

export const providerCheckResultValidator = v.object({
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
// lifecycle core (`lib/lifecycle.ts`, ADR-0058); the reducers and the effect
// declarations below stay here, and the per-provider identity write and the
// effect runner live in `lifecycle.ts`. `reportsTerminalRefusals` is
// off — no state is terminal (a verified domain can be re-registered, a failed
// one re-checked) and the published outcome union carries only `illegal_edge`.

export const SENDING_DOMAIN_LIFECYCLE = defineLifecycle<SendingDomainStatus>({
	registering: ['pending', 'failed'],
	pending: ['verified', 'failed', 'registering'],
	verified: ['registering', 'failed', 'pending'],
	failed: ['registering', 'verified', 'pending'],
});

// ─── Effects ────────────────────────────────────────────────────────────────

export type Effect =
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

export function reduce(domain: Doc<'domains'>, input: SendingDomainTransitionInput): ReducerResult {
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
