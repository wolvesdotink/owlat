import { v } from 'convex/values';
import type { Infer } from 'convex/values';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id, Doc } from '../_generated/dataModel';
import {
	throwInvalidInput,
	throwAlreadyExists,
	throwNotFound,
	throwInvalidState,
} from '../_utils/errors';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { getOptional } from '../lib/env';
import { dmarcPolicyValidator } from './dmarc';
import {
	dnsRecordValidator,
	dnsRecordsValidator,
	verificationResultValidator,
	verificationResultsValidator,
} from '../lib/convexValidators';
import { emailDomain, extractDomainOrNull, asDnsName } from '@owlat/shared';

// Types derived from validators for DNS records
export type DnsRecord = Infer<typeof dnsRecordValidator>;
export type DnsRecords = Infer<typeof dnsRecordsValidator>;
export type VerificationResult = Infer<typeof verificationResultValidator>;
export type VerificationResults = Infer<typeof verificationResultsValidator>;

type DomainRow = Doc<'domains'>;

/**
 * Narrow a stored `domains` row's loosely-typed `dnsRecords` /
 * `verificationResults` JSON columns to their validator-derived shapes for the
 * read queries. One copy of the cast so the three single-row readers
 * (`listByOrganization`, `get`, `getByDomain`) can't disagree.
 */
function serializeDomainRow(domain: DomainRow): DomainRow & {
	dnsRecords: DnsRecords;
	verificationResults: VerificationResults | undefined;
} {
	return {
		...domain,
		dnsRecords: domain.dnsRecords as DnsRecords,
		verificationResults: domain.verificationResults as VerificationResults | undefined,
	};
}

// Synthetic userId tag for user-driven public-mutation transitions. Replaces
// the implicit `system:` prefix the lifecycle's reducer recognizes —
// user-driven calls don't have a `system:` prefix.
const LIFECYCLE_USER_PUBLIC_MUTATION = 'user';

// ─── Read queries ──────────────────────────────────────────────────────────

// Query: List all domains
export const listByOrganization = authedQuery({
	args: {},
	handler: async (ctx) => {
		const domains = await ctx.db.query('domains').collect(); // bounded: verified sending domains (few per org)

		return domains.map(serializeDomainRow);
	},
});

// Query: Get a single domain by ID
export const get = authedQuery({
	args: {
		domainId: v.id('domains'),
	},
	handler: async (ctx, args) => {
		const domain = await ctx.db.get(args.domainId);
		if (!domain) return null;

		return serializeDomainRow(domain);
	},
});

// Query: Get a domain by domain name
export const getByDomain = authedQuery({
	args: {
		domain: v.string(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('domains')
			.withIndex('by_domain', (q) => q.eq('domain', args.domain))
			.first();

		if (!existing) return null;

		return serializeDomainRow(existing);
	},
});

/**
 * The TCP port other mail servers connect to when delivering inbound mail to
 * this deployment's MTA. 587/465 are SMTP *submission* (authenticated sending),
 * not inbound MX delivery, so they are intentionally excluded — the Receiving
 * panel is about receiving mail, not sending it.
 */
export const INBOUND_SMTP_PORT = 25;

// Query: Deployment-level inbound mail config for the Settings → Domains
// "Receiving" panel. Returns the MTA's public EHLO/MX hostname (the target a
// domain must point its MX record at to receive mail through this deployment)
// and the inbound SMTP port. `mailHost` is null when EHLO_HOSTNAME is unset
// (a send-only install with no inbound MTA), so the UI can omit the guidance.
//
// Admin-gated (organization:manage): publishing MX / opening inbound ports is an
// operator task, mirroring the add/remove/verify domain gates on this page. The
// values themselves are non-secret (they become public DNS), but the read is
// kept admin-only for parity with the rest of the domain-management surface.
export const getInboundMailConfig = authedQuery({
	args: {},
	handler: async (ctx) => {
		await requireOrgPermission(ctx, 'organization:manage');
		const mailHost = getOptional('EHLO_HOSTNAME')?.trim() || null;
		return { mailHost, inboundPort: INBOUND_SMTP_PORT };
	},
});

// The MTA-STS policy/guidance queries (`getMtaStsPolicy`, `getMtaStsGuidance`)
// live in the sibling `domains/mtaSts.ts`, and the live verification action in
// `domains/mtaStsVerify.ts`.

// Query: Count domains by status
export const countByStatus = authedQuery({
	args: {},
	handler: async (ctx) => {
		const domains = await ctx.db.query('domains').collect(); // bounded: per-deployment sending domain set is small (single-digit typical)

		const counts = {
			total: domains.length,
			registering: 0,
			pending: 0,
			verified: 0,
			failed: 0,
		};
		for (const d of domains) {
			if (d.status === 'registering') counts.registering++;
			else if (d.status === 'pending') counts.pending++;
			else if (d.status === 'verified') counts.verified++;
			else if (d.status === 'failed') counts.failed++;
		}
		return counts;
	},
});

// Query: Get verified domains (for email sending)
export const listVerified = authedQuery({
	args: {},
	handler: async (ctx) => {
		const domains = await ctx.db
			.query('domains')
			.withIndex('by_status', (q) => q.eq('status', 'verified'))
			.collect(); // bounded: per-deployment verified domain set is small

		return domains.map((domain) => ({
			_id: domain._id,
			domain: domain.domain,
			verifiedAt: domain.verifiedAt,
		}));
	},
});

// ─── Write mutations — thin auth shells over the Sending domain lifecycle ──

// Mutation: Add a new domain. Delegates to the lifecycle's `create()`
// entry point, which inserts the row and fires `register_with_provider`.
export const create = authedMutation({
	args: {
		domain: v.string(),
	},
	handler: async (ctx, args): Promise<Id<'domains'>> => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can manage sending domains'
		);
		const outcome = await ctx.runMutation(internal.domains.lifecycle.create, {
			domain: args.domain,
			userId: LIFECYCLE_USER_PUBLIC_MUTATION,
		});
		if (!outcome.ok) {
			if (outcome.reason === 'invalid_format') {
				throwInvalidInput('Invalid domain format. Please enter a valid domain name.');
			}
			if (outcome.reason === 'already_exists') {
				throwAlreadyExists('This domain has already been added.');
			}
		}
		// Narrowing: ok is true at this point.
		return (outcome as { ok: true; domainId: Id<'domains'> }).domainId;
	},
});

// Mutation: Remove a domain. Delegates to the lifecycle's `remove()` entry
// point, which clears the provider identity row, deletes the domain row,
// and schedules best-effort provider cleanup.
export const remove = authedMutation({
	args: {
		domainId: v.id('domains'),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can manage sending domains'
		);
		const outcome = await ctx.runMutation(internal.domains.lifecycle.remove, {
			domainId: args.domainId,
			userId: LIFECYCLE_USER_PUBLIC_MUTATION,
		});
		if (!outcome.ok && outcome.reason === 'domain_not_found') {
			throwNotFound('Domain');
		}
	},
});

// Mutation: Re-register domain with the provider. Delegates to the
// lifecycle's `transition({ to: 'registering' })`, which clears the previous
// identity and fires a fresh `register_with_provider`.
export const regenerateDnsRecords = authedMutation({
	args: {
		domainId: v.id('domains'),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can manage sending domains'
		);
		const outcome = await ctx.runMutation(internal.domains.lifecycle.transition, {
			domainId: args.domainId,
			input: { to: 'registering', at: Date.now() },
			userId: LIFECYCLE_USER_PUBLIC_MUTATION,
		});
		if (!outcome.ok) {
			if (outcome.reason === 'domain_not_found') throwNotFound('Domain');
			throwInvalidState(`Cannot regenerate: ${outcome.reason}`);
		}
	},
});

// Mutation: Set the domain's DMARC enforcement policy (none | quarantine |
// reject) plus the optional RFC 7489 §6.3 enforcement knobs — `subdomainPolicy`
// (sp=) and `pct` (staged-rollout percentage). Delegates to the lifecycle's
// `setDmarcPolicy`, which regenerates the `_dmarc` TXT record from the new
// settings and drops the stale DMARC verification result so the customer
// re-publishes + re-verifies that record.
export const setDmarcPolicy = authedMutation({
	args: {
		domainId: v.id('domains'),
		policy: dmarcPolicyValidator,
		subdomainPolicy: v.optional(dmarcPolicyValidator),
		pct: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can manage sending domains'
		);
		if (args.pct !== undefined && (!Number.isInteger(args.pct) || args.pct < 0 || args.pct > 100)) {
			throwInvalidInput('DMARC pct must be an integer between 0 and 100');
		}
		const outcome = await ctx.runMutation(internal.domains.lifecycle.setDmarcPolicy, {
			domainId: args.domainId,
			policy: args.policy,
			subdomainPolicy: args.subdomainPolicy,
			pct: args.pct,
			userId: LIFECYCLE_USER_PUBLIC_MUTATION,
		});
		if (!outcome.ok) {
			if (outcome.reason === 'domain_not_found') throwNotFound('Domain');
			if (outcome.reason === 'no_dmarc_record') {
				throwInvalidState('This domain has no DMARC record yet. Finish registration first.');
			}
		}
	},
});

// Mutation: Set (or change) the domain's per-domain VERP return-path host
// (D1/D2). Delegates to the lifecycle's `setReturnPathHost`, which regenerates
// the `mailFrom` SPF record on the new host, drops the domain to `pending` for
// re-verification, and reflects the host to the MTA. Admin-gated
// (`organization:manage`) to match the other domain-management writes.
export const setReturnPathHost = authedMutation({
	args: {
		domainId: v.id('domains'),
		returnPathHost: v.string(),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can manage sending domains'
		);
		// Validate + normalize the host up front with the shared DNS-name
		// primitive so a bad value is a clean 400 (`invalid_input`) rather than a
		// lifecycle miss. The lifecycle re-validates (defense in depth).
		const normalized = asDnsName(args.returnPathHost);
		if (normalized === null) {
			throwInvalidInput(
				'Invalid return-path host. Enter a valid DNS hostname, e.g. bounce.example.com.'
			);
		}
		const outcome = await ctx.runMutation(internal.domains.lifecycle.setReturnPathHost, {
			domainId: args.domainId,
			returnPathHost: normalized,
			userId: LIFECYCLE_USER_PUBLIC_MUTATION,
		});
		if (!outcome.ok) {
			if (outcome.reason === 'domain_not_found') throwNotFound('Domain');
			if (outcome.reason === 'invalid_host') {
				throwInvalidInput('Invalid return-path host.');
			}
			throwInvalidState(`Cannot set return-path host: ${outcome.reason}`);
		}
	},
});

// ─── Read queries used by the builder UI and outbound sending paths ────────

// Query: Check if a domain is verified for sending (for UI validation)
export const isDomainVerified = authedQuery({
	args: {
		domain: v.string(),
	},
	handler: async (ctx, args): Promise<{ verified: boolean; exists: boolean }> => {
		const domainRecord = await ctx.db
			.query('domains')
			.withIndex('by_domain', (q) => q.eq('domain', args.domain.toLowerCase()))
			.first();

		if (!domainRecord) {
			return { verified: false, exists: false };
		}

		return {
			verified: domainRecord.status === 'verified',
			exists: true,
		};
	},
});

// Query: Check if domain verification is fresh (not stale)
export const isDomainVerificationFresh = authedQuery({
	args: {
		domain: v.string(),
		maxAgeHours: v.optional(v.number()), // Default: 24 hours
	},
	handler: async (
		ctx,
		args
	): Promise<{
		fresh: boolean;
		stale: boolean;
		verified: boolean;
		lastVerifiedAt?: number;
	}> => {
		const maxAgeHours = args.maxAgeHours ?? 24;

		const domainRecord = await ctx.db
			.query('domains')
			.withIndex('by_domain', (q) => q.eq('domain', args.domain.toLowerCase()))
			.first();

		if (!domainRecord) {
			return { fresh: false, stale: false, verified: false };
		}

		if (domainRecord.status !== 'verified') {
			return {
				fresh: false,
				stale: false,
				verified: false,
				lastVerifiedAt: domainRecord.lastVerifiedAt,
			};
		}

		if (!domainRecord.lastVerifiedAt) {
			return {
				fresh: false,
				stale: true,
				verified: true,
				lastVerifiedAt: undefined,
			};
		}

		const now = Date.now();
		const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
		const stale = now - domainRecord.lastVerifiedAt > maxAgeMs;

		return {
			fresh: !stale,
			stale,
			verified: true,
			lastVerifiedAt: domainRecord.lastVerifiedAt,
		};
	},
});

// Query: Get verification status for an email's domain (for UI warnings)
export interface EmailDomainVerificationStatus {
	domain: string;
	exists: boolean;
	verified: boolean;
	stale: boolean;
	lastVerifiedAt?: number;
	error?: string;
}

/**
 * Verify the sending domain of an email address. Shared between the public
 * query (`getEmailDomainVerificationStatus`) and any internal mutation that
 * needs the same gate without an indirection round-trip — notably the
 * **Transactional send intake (module)** (`convex/transactional/dispatch.ts`).
 */
export async function checkEmailDomainVerification(
	ctx: QueryCtx | MutationCtx,
	email: string
): Promise<EmailDomainVerificationStatus> {
	const domain = extractDomainOrNull(email);
	if (!domain) {
		return {
			domain: '',
			exists: false,
			verified: false,
			stale: false,
			error: `Invalid email address: ${email}`,
		};
	}

	const domainRecord = await ctx.db
		.query('domains')
		.withIndex('by_domain', (q) => q.eq('domain', domain))
		.first();

	if (!domainRecord) {
		return {
			domain,
			exists: false,
			verified: false,
			stale: false,
			error: `Domain "${domain}" is not registered. Please add it in Settings > Domains.`,
		};
	}

	if (domainRecord.status !== 'verified') {
		return {
			domain,
			exists: true,
			verified: false,
			stale: false,
			lastVerifiedAt: domainRecord.lastVerifiedAt,
			error: `Domain "${domain}" is not verified. Please verify DNS records in Settings > Domains.`,
		};
	}

	const maxAgeMs = 24 * 60 * 60 * 1000;
	const stale = !domainRecord.lastVerifiedAt || Date.now() - domainRecord.lastVerifiedAt > maxAgeMs;

	return {
		domain,
		exists: true,
		verified: true,
		stale,
		lastVerifiedAt: domainRecord.lastVerifiedAt,
	};
}

/**
 * Build a request-scoped memoizer for {@link checkEmailDomainVerification}.
 *
 * Domain verification depends only on the address's domain, and a From-picker
 * commonly lists many addresses on one org domain — so the same `domains` row
 * would otherwise be re-queried once per sender. The returned closure keys the
 * pending lookup by the address's domain, reading each `domains` row once per
 * request. Shared by the campaign-sender and send-as-identity picker queries.
 */
export function memoizedEmailDomainVerification(
	ctx: QueryCtx | MutationCtx
): (email: string) => Promise<EmailDomainVerificationStatus> {
	const byDomain = new Map<string, Promise<EmailDomainVerificationStatus>>();
	return (email: string) => {
		const domain = emailDomain(email);
		let pending = byDomain.get(domain);
		if (!pending) {
			pending = checkEmailDomainVerification(ctx, email);
			byDomain.set(domain, pending);
		}
		return pending;
	};
}

export const getEmailDomainVerificationStatus = authedQuery({
	args: {
		email: v.string(),
	},
	handler: async (ctx, args): Promise<EmailDomainVerificationStatus> => {
		return await checkEmailDomainVerification(ctx, args.email);
	},
});
