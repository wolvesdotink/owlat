/**
 * Yahoo Complaint Feedback Loop (CFL) — guided DKIM-domain enrollment.
 *
 * Yahoo's CFL has no API and no credential: enrollment is a bilateral, manual
 * step the operator performs against a DKIM DOMAIN on Yahoo's sender site. So
 * this module is a thin shell over the pure state machine in
 * `@owlat/shared/yahooCfl` — it loads the record, calls the pure function, and
 * writes the result. All the decisions live in the pure core (and are tested
 * there exhaustively).
 *
 * REPORTS ARE NOT PARSED HERE. A Yahoo CFL report is an ordinary RFC 5965 ARF
 * message and flows through the SHIPPED MTA processor
 * (`apps/mta/src/bounce/fblProcessor.ts`) and the existing complaint pipeline.
 * The only thing this module consumes is the fact that one was OBSERVED, which
 * is the liveness proof the re-check reads. One complaint pipeline, three
 * sources — never a second parser.
 *
 * D2 (additive-only third-party rule): every function here tolerates absence.
 * No enrollment row means `not_started`, which yields the documented
 * substitution (CFBL feed, else the tightened unsubscribe proxy) with a
 * confidence caveat. Nothing here throws on absence, blocks a send, blocks a
 * phase promotion, or renders a "setup incomplete" nag.
 */

import { v } from 'convex/values';
import {
	applyYahooCflEvent,
	deriveYahooCflState,
	emptyYahooCflEnrollment,
	yahooCflGuidedSteps,
	yahooComplaintSubstitution,
	type YahooCflDkimPrecondition,
	type YahooCflEnrollmentRecord,
	type YahooCflEvent,
	type YahooCflStoredState,
	type YahooCflTransitionReason,
} from '@owlat/shared/yahooCfl';
import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from '../_generated/server';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { getSingletonOrganizationId, requireOrgPermission } from '../lib/sessionOrganization';

function recordOf(row: Doc<'yahooCflEnrollments'> | null): YahooCflEnrollmentRecord {
	if (!row) return emptyYahooCflEnrollment();
	return {
		state: row.state,
		...(row.dkimDomain === undefined ? {} : { dkimDomain: row.dkimDomain }),
		...(row.submittedAt === undefined ? {} : { submittedAt: row.submittedAt }),
		...(row.enrolledAt === undefined ? {} : { enrolledAt: row.enrolledAt }),
		...(row.lastReportAt === undefined ? {} : { lastReportAt: row.lastReportAt }),
	};
}

/**
 * One enrollment slot: where the row lives and what (if anything) is in it.
 *
 * The three values travel together everywhere — the loader produces them, the
 * writer consumes them — so they are ONE value rather than three parameters
 * repeated at every call site.
 */
interface EnrollmentSlot {
	organizationId: string;
	domainId: Id<'domains'>;
	existing: Doc<'yahooCflEnrollments'> | null;
}

/**
 * Load the org-scoped enrollment slot. Scoping the LOOKUP (rather than
 * filtering after the fact) is what makes a foreign row invisible: a report or
 * an operator action can never read, patch, or leak another tenant's row.
 */
async function loadEnrollment(
	ctx: QueryCtx | MutationCtx,
	organizationId: string,
	domainId: Id<'domains'>
): Promise<EnrollmentSlot> {
	const existing = await ctx.db
		.query('yahooCflEnrollments')
		.withIndex('by_org_domain', (q) =>
			q.eq('organizationId', organizationId).eq('domainId', domainId)
		)
		.first();
	return { organizationId, domainId, existing };
}

/** The DKIM precondition: a verified domain that carries an MTA DKIM selector. */
async function preconditionFor(
	ctx: QueryCtx | MutationCtx,
	domain: Doc<'domains'>
): Promise<YahooCflDkimPrecondition> {
	const identity = await ctx.db
		.query('sendingDomainMtaIdentities')
		.withIndex('by_domain', (q) => q.eq('domainId', domain._id))
		.first();
	return {
		domain: domain.domain,
		isVerified: domain.status === 'verified',
		...(identity ? { dkimSelector: identity.dkimSelector } : {}),
	};
}

async function persist(
	ctx: MutationCtx,
	slot: EnrollmentSlot,
	record: YahooCflEnrollmentRecord,
	now: number
): Promise<void> {
	if (slot.existing) {
		// PATCH deletes a field given an explicit `undefined`, which is exactly what
		// a `reset` needs: its record carries no timestamps and the row must not keep
		// the old ones. Spelled out here because it is the one Convex behaviour this
		// function depends on that is not obvious from the call site.
		await ctx.db.patch(slot.existing._id, {
			state: record.state,
			dkimDomain: record.dkimDomain,
			submittedAt: record.submittedAt,
			enrolledAt: record.enrolledAt,
			lastReportAt: record.lastReportAt,
			updatedAt: now,
		});
		return;
	}
	// INSERT writes only the fields the record actually carries (the repo's
	// spread-when-present idiom, same as `recordOf` above), so a fresh row never
	// depends on insert accepting an explicit `undefined` for an optional field.
	await ctx.db.insert('yahooCflEnrollments', {
		organizationId: slot.organizationId,
		domainId: slot.domainId,
		state: record.state,
		...(record.dkimDomain === undefined ? {} : { dkimDomain: record.dkimDomain }),
		...(record.submittedAt === undefined ? {} : { submittedAt: record.submittedAt }),
		...(record.enrolledAt === undefined ? {} : { enrolledAt: record.enrolledAt }),
		...(record.lastReportAt === undefined ? {} : { lastReportAt: record.lastReportAt }),
		createdAt: now,
		updatedAt: now,
	});
}

/**
 * Run one guided-flow event against a domain. Shared by every operator-facing
 * mutation so the auth floor, the precondition and the persistence are written
 * exactly once.
 */
async function runEvent(
	ctx: MutationCtx,
	domainId: Id<'domains'>,
	event: YahooCflEvent
): Promise<{ state: YahooCflStoredState; changed: boolean; reason: YahooCflTransitionReason }> {
	const session = await requireOrgPermission(ctx, 'organization:manage');
	const domain = await ctx.db.get(domainId);
	// An unknown domain is not an error state for the operator to resolve — it
	// means the domain was deleted underneath the wizard. Its OWN reason, never
	// `dkim_domain_not_ready`: telling the operator to publish a DKIM record for a
	// domain that no longer exists is advice they cannot act on.
	if (!domain) return { state: 'not_started', changed: false, reason: 'domain_missing' };
	const slot = await loadEnrollment(ctx, session.activeOrganizationId, domainId);
	const transition = applyYahooCflEvent(
		recordOf(slot.existing),
		event,
		await preconditionFor(ctx, domain)
	);
	if (transition.changed) {
		await persist(ctx, slot, transition.record, event.at);
	}
	return {
		state: transition.record.state,
		changed: transition.changed,
		reason: transition.reason,
	};
}

// ─── Operator surface ───────────────────────────────────────────────────────

/**
 * The guided flow for one domain: current state, the four steps with their
 * "how to tell it worked", and which complaint signal the yahoo cell is
 * actually running on right now.
 */
export const getGuide = authedQuery({
	args: { domainId: v.id('domains') },
	handler: async (ctx, args) => {
		// Domain-level sending configuration, same gate as every other write on
		// this wizard: only owners/admins see or change it.
		const session = await requireOrgPermission(ctx, 'organization:manage');
		const domain = await ctx.db.get(args.domainId);
		if (!domain) return null;
		const slot = await loadEnrollment(ctx, session.activeOrganizationId, args.domainId);
		const record = recordOf(slot.existing);
		const precondition = await preconditionFor(ctx, domain);
		const now = Date.now();
		// The re-check, derived on read: `lapsed` is a function of the last observed
		// report and the clock, so this verdict is always current (ADR-0042).
		const { state, silentMs } = deriveYahooCflState(record, now);
		return {
			domain: domain.domain,
			// The DERIVED state (`lapsed` included) is the only state reported —
			// `enrollment.state` carries the stored one, so a consumer can never read
			// two sources for the same fact.
			state,
			silentMs,
			enrollment: record,
			precondition,
			steps: yahooCflGuidedSteps(record, precondition, now),
			// The yahoo cell's gate-3 source. Always present — absence of an
			// enrollment substitutes, it never blanks the gate out (D2).
			//
			// `hasCfblAddress` is resolved SERVER-side and is `false` until P2-7 lands
			// the RFC 9477 CFBL-Address feed: there is nothing to read yet, and a
			// client-supplied flag steering the reported confidence and threshold
			// would be a speculative seam (D20).
			complaintSignal: yahooComplaintSubstitution({
				enrollmentState: state,
				hasCfblAddress: false,
			}),
		};
	},
});

/** Step 2: the operator submitted Yahoo's form. */
export const submitEnrollment = authedMutation({
	// authz: runEvent() gates on requireOrgPermission(ctx, 'organization:manage').
	args: { domainId: v.id('domains') },
	handler: async (ctx, args) => runEvent(ctx, args.domainId, { kind: 'submit', at: Date.now() }),
});

/** Step 3: Yahoo acknowledged the domain. */
export const confirmEnrollment = authedMutation({
	// authz: runEvent() gates on requireOrgPermission(ctx, 'organization:manage').
	args: { domainId: v.id('domains') },
	handler: async (ctx, args) => runEvent(ctx, args.domainId, { kind: 'confirm', at: Date.now() }),
});

/** Start over — e.g. the enrollment lapsed and is being re-submitted. */
export const resetEnrollment = authedMutation({
	// authz: runEvent() gates on requireOrgPermission(ctx, 'organization:manage').
	args: { domainId: v.id('domains') },
	handler: async (ctx, args) => runEvent(ctx, args.domainId, { kind: 'reset', at: Date.now() }),
});

// ─── Report observation ─────────────────────────────────────────────────────

/**
 * Record that a Yahoo CFL report arrived for one of our sending domains.
 *
 * Called from the webhook dispatcher on an `email.complained` event whose ARF
 * source ISP is Yahoo. It is deliberately TOTAL: an unknown or foreign domain
 * is a silent no-op, never a throw, because it runs on the complaint path and
 * a complaint must always reach the blocklist regardless of what this records.
 *
 * A report can only ever CONFIRM an enrollment the operator started: every fact
 * this path could gate on arrives in the report itself, so the pure core refuses
 * a `not_started` domain (`reason: 'not_submitted'`) and no row is created here.
 * Otherwise one crafted message to the FBL address would manufacture an
 * enrollment, and with it the looser direct complaint threshold at
 * `confidence: 'high'` for a domain with no Yahoo feed at all.
 *
 * This write is also the whole of the re-check: `lapsed` is derived from
 * `lastReportAt`, so a report both records the complaint and un-lapses the cell
 * with no second pass, no cron, and no chance of a stale verdict. The write is
 * COALESCED in the pure core (`YAHOO_CFL_REPORT_COALESCE_MS`): complaints arrive
 * in bursts and all of a domain's reports land on ONE row, so patching per report
 * is the single-document OCC contention ADR-0042 was written about (D16).
 */
export const observeReport = internalMutation({
	args: { reportedDomain: v.string(), at: v.number() },
	handler: async (ctx, args) => {
		// This mutation is reachable from an internet-triggered path (an ARF report),
		// so the clock it is handed is untrusted. A non-finite or non-positive `at`
		// would be absorbed by the pure core's `Math.max` and pin the row
		// permanently `enrolled` / never `lapsed`, holding the yahoo complaint gate
		// on the looser direct threshold instead of the tightened proxy.
		if (!Number.isFinite(args.at) || args.at <= 0) return { observed: false as const };
		const name = args.reportedDomain.trim().toLowerCase();
		if (name.length === 0 || name.length > 253) return { observed: false as const };
		const domain = await ctx.db
			.query('domains')
			.withIndex('by_domain', (q) => q.eq('domain', name))
			.first();
		// A report naming a domain this deployment does not send from proves
		// nothing about our enrollment; drop it rather than inventing a row.
		if (!domain) return { observed: false as const };
		const organizationId = await getSingletonOrganizationId(ctx);
		const slot = await loadEnrollment(ctx, organizationId, domain._id);
		const transition = applyYahooCflEvent(
			recordOf(slot.existing),
			{ kind: 'report_observed', at: args.at },
			await preconditionFor(ctx, domain)
		);
		if (transition.changed) {
			await persist(ctx, slot, transition.record, args.at);
		}
		return { observed: true as const, state: transition.record.state, reason: transition.reason };
	},
});
