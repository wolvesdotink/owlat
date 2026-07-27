/**
 * Yahoo Complaint Feedback Loop (CFL) — the pure enrollment state machine.
 *
 * Yahoo's CFL is DKIM-DOMAIN based: there is no API and no credential to store,
 * only a bilateral enrollment the operator performs on Yahoo's sender site
 * against a domain we already sign with DKIM. So the whole integration is a
 * GUIDED FLOW plus a recorded state, and every decision it makes is a pure
 * function of (record, DKIM precondition, clock) — no I/O, no `Date.now()` (D15).
 *
 * ARF PARSING IS NOT HERE. A Yahoo CFL report is an ordinary RFC 5965 ARF
 * message and routes through the SHIPPED processor
 * (`apps/mta/src/bounce/fblProcessor.ts`), whose `isp()` map already resolves
 * Yahoo. Nothing in this module parses a report; it only records that one was
 * OBSERVED, which is what proves the enrollment is still live.
 *
 * `lapsed` IS DERIVED, NEVER STORED (ADR-0042's derive-on-read rule): it is a
 * pure function of the last observed report and the clock, so the re-check needs
 * no cron and no write, and the wizard can never show a stale verdict.
 *
 * D2 (the additive-only third-party rule) is the invariant this module exists
 * to honour: being un-enrolled is a SUPPORTED CONFIGURATION. It lowers
 * measurement confidence and substitutes a tighter proxy threshold for the
 * complaint gate. It never throws, never blocks a send, never blocks a phase
 * promotion, and never produces an error state or a "setup incomplete" nag.
 *
 * WHICH complaint signal that substitution picks lives in the sibling module
 * `./yahooComplaintSignal` — a different concern with a different owner (P3-8's
 * substitution table subsumes that file, not this state machine).
 */

/**
 * The states the flow actually PERSISTS.
 *
 * - `not_started` — nothing submitted. The default for every domain, forever,
 *   if the operator never enrolls. Not an error.
 * - `awaiting_yahoo` — the operator submitted the form; Yahoo has not yet
 *   started sending reports.
 * - `enrolled` — reports are flowing (or the operator confirmed approval).
 */
export const YAHOO_CFL_STORED_STATES = ['not_started', 'awaiting_yahoo', 'enrolled'] as const;
export type YahooCflStoredState = (typeof YAHOO_CFL_STORED_STATES)[number];

/**
 * The four states the guided flow PRESENTS. `lapsed` is the derived one: an
 * `enrolled` domain that has seen no report for long enough that the enrollment
 * is probably no longer live and is worth re-checking at Yahoo.
 */
export const YAHOO_CFL_ENROLLMENT_STATES = [...YAHOO_CFL_STORED_STATES, 'lapsed'] as const;
export type YahooCflEnrollmentState = (typeof YAHOO_CFL_ENROLLMENT_STATES)[number];

/** Where the operator performs the enrollment. Informational only. */
export const YAHOO_CFL_ENROLLMENT_URL = 'https://senders.yahooinc.com/complaint-feedback-loop/';

/**
 * Silence that makes an `enrolled` domain read as `lapsed`.
 *
 * Yahoo emits a report only when a recipient hits "Report Spam", so a genuinely
 * clean low-volume domain can be silent for a long time. 90 days is chosen to
 * be far longer than any plausible clean streak: the derived state is a PROMPT
 * TO RE-CHECK, never an alarm, and `lapsed` is deliberately not an error state.
 */
export const YAHOO_CFL_LAPSE_SILENCE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * How long a submission may sit in `awaiting_yahoo` before the guided flow
 * suggests re-submitting. Yahoo's review is manual and typically days.
 */
export const YAHOO_CFL_SUBMISSION_PATIENCE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * How much `lastReportAt` must ADVANCE before a report is worth a write.
 *
 * D16 / ADR-0042: complaints arrive in bursts, and every report for a domain
 * lands on the SAME enrollment row — patching it per complaint is exactly the
 * single-document OCC contention ADR-0042 was written about, and on the complaint
 * hot path a write conflict costs a complaint. The row exists only to prove
 * liveness against a 90-day lapse window, so one write per hour carries all the
 * information the derived verdict can use; the rest is coalesced away.
 */
export const YAHOO_CFL_REPORT_COALESCE_MS = 60 * 60 * 1000;

/** The lapse / patience windows in whole days, for operator-facing copy. */
function inDays(ms: number): number {
	return Math.round(ms / (24 * 60 * 60 * 1000));
}

/** The persisted enrollment record, as a plain value the pure core operates on. */
export interface YahooCflEnrollmentRecord {
	state: YahooCflStoredState;
	/** The DKIM domain the enrollment was submitted for, as submitted. */
	dkimDomain?: string;
	/** When the operator told us they submitted Yahoo's form. */
	submittedAt?: number;
	/** When enrollment was confirmed (by the operator, or by a first report). */
	enrolledAt?: number;
	/** When we last saw a Yahoo ARF report attributed to this domain. */
	lastReportAt?: number;
}

/** The DKIM-domain precondition the guided flow gates step 2 on. */
export interface YahooCflDkimPrecondition {
	domain: string;
	/** The sending domain reached `verified` in the domain lifecycle. */
	isVerified: boolean;
	/** The MTA identity's DKIM selector, when one has been written. */
	dkimSelector?: string;
}

/** A fresh, never-enrolled record. The default for every domain. */
export function emptyYahooCflEnrollment(): YahooCflEnrollmentRecord {
	return { state: 'not_started' };
}

/**
 * Yahoo only accepts an enrollment for a domain it can see our DKIM signature
 * on, so the flow refuses to advance past step 1 until the domain is verified
 * AND carries a selector. This is a PRECONDITION on our own guided flow, not a
 * gate on sending: mail to Yahoo keeps flowing either way.
 */
export function yahooCflPreconditionMet(precondition: YahooCflDkimPrecondition): boolean {
	return precondition.isVerified && (precondition.dkimSelector ?? '').trim().length > 0;
}

/**
 * THE RE-CHECK, derived on read: how long this enrollment has been silent, and
 * therefore whether it reads as `lapsed` right now.
 *
 * `enrolledAt` is the fallback origin so an enrollment that never produced a
 * single report still eventually prompts a re-check. A record with neither
 * timestamp (or a clock behind the record) is treated as freshly enrolled —
 * uncertainty is never laundered into a lapse.
 */
export function deriveYahooCflState(
	record: YahooCflEnrollmentRecord,
	nowMs: number
): { state: YahooCflEnrollmentState; silentMs: number } {
	if (record.state !== 'enrolled') return { state: record.state, silentMs: 0 };
	const since = record.lastReportAt ?? record.enrolledAt ?? nowMs;
	const silentMs = Math.max(0, nowMs - since);
	return {
		state: silentMs >= YAHOO_CFL_LAPSE_SILENCE_MS ? 'lapsed' : 'enrolled',
		silentMs,
	};
}

export type YahooCflEvent =
	| { kind: 'submit'; at: number }
	| { kind: 'confirm'; at: number }
	| { kind: 'report_observed'; at: number }
	| { kind: 'reset'; at: number };

/**
 * Why a transition did (or did not) happen. Every value is a stable token the
 * UI maps to human-readable copy — the flow never surfaces a bare boolean.
 */
export type YahooCflTransitionReason =
	| 'submitted'
	| 'resubmitted'
	| 'confirmed'
	| 'report_confirms_enrollment'
	| 'report_recorded'
	| 'reset'
	| 'dkim_domain_not_ready'
	/** The domain was deleted underneath the wizard. Not the operator's problem to fix. */
	| 'domain_missing'
	| 'not_submitted'
	| 'already_enrolled'
	| 'nothing_to_reset'
	/** A non-finite or non-positive `at`. Refused rather than absorbed. */
	| 'invalid_timestamp';

export interface YahooCflTransition {
	record: YahooCflEnrollmentRecord;
	changed: boolean;
	reason: YahooCflTransitionReason;
}

function unchanged(
	record: YahooCflEnrollmentRecord,
	reason: YahooCflTransitionReason
): YahooCflTransition {
	return { record, changed: false, reason };
}

/**
 * The state machine. Pure: same inputs, same output, no clock read.
 *
 * A refused transition is NOT an error — it returns `changed: false` plus the
 * reason, so the caller renders guidance instead of throwing (D2).
 */
export function applyYahooCflEvent(
	record: YahooCflEnrollmentRecord,
	event: YahooCflEvent,
	precondition: YahooCflDkimPrecondition
): YahooCflTransition {
	// A garbage clock never reaches the record. `Math.max` below would happily
	// absorb `Infinity` or a negative value and pin the row permanently `enrolled`
	// (or permanently un-lapsable), which would hold the yahoo complaint gate on
	// the looser direct threshold forever. Refuse it instead — refusing is not an
	// error, it is a reason (D2).
	if (!Number.isFinite(event.at) || event.at <= 0) return unchanged(record, 'invalid_timestamp');
	switch (event.kind) {
		case 'submit': {
			// A LIVE enrollment has nothing to submit. A LAPSED one does: that is the
			// whole point of the derived lapse, and re-submitting Yahoo's form is the
			// documented remedy the fourth step names. So the refusal is keyed on the
			// DERIVED state, not the stored one — `event.at` is the clock (D15: the
			// clock is a parameter, never read here).
			const derived = deriveYahooCflState(record, event.at).state;
			// Checked BEFORE the precondition: a live enrollment on a domain that has
			// since lost its DKIM readiness must not be told to "publish a DKIM record"
			// for a domain Yahoo already accepted. A lapsed record derives as `lapsed`
			// and still falls through to the precondition below.
			if (derived === 'enrolled') return unchanged(record, 'already_enrolled');
			if (!yahooCflPreconditionMet(precondition)) {
				return unchanged(record, 'dkim_domain_not_ready');
			}
			// Built field by field rather than spread over `record`, because the fields
			// it does NOT carry are the point: `enrolledAt` is dropped, since the
			// enrollment being re-submitted for is no longer believed live and keeping
			// its confirmation date would give `deriveYahooCflState` a stale fallback
			// origin. `lastReportAt` is KEPT — it is observed history, and it is what a
			// fresh report has to beat for the liveness verdict to move.
			return {
				record: {
					state: 'awaiting_yahoo',
					dkimDomain: precondition.domain,
					submittedAt: event.at,
					...(record.lastReportAt === undefined ? {} : { lastReportAt: record.lastReportAt }),
				},
				changed: true,
				reason: derived === 'not_started' ? 'submitted' : 'resubmitted',
			};
		}
		case 'confirm': {
			if (record.state === 'enrolled') return unchanged(record, 'already_enrolled');
			if (record.state === 'not_started') return unchanged(record, 'not_submitted');
			return {
				record: { ...record, state: 'enrolled', enrolledAt: event.at },
				changed: true,
				reason: 'confirmed',
			};
		}
		case 'report_observed': {
			// OPERATOR INTENT IS REQUIRED BEFORE A REPORT MAY PROMOTE ANYTHING.
			//
			// Everything this branch could gate on is REPORT-SUPPLIED, not
			// authenticated: the source-ISP token is derived from the report's own
			// `User-Agent` and `Reported-Domain` is the report's own RFC 5965 field.
			// The only real authentication upstream is a VERP-attributed
			// `originalMessageId`, and every recipient of every send already holds a
			// valid one in their copy's Return-Path. So a single crafted message to
			// the FBL address would otherwise MANUFACTURE an enrollment for a domain
			// the operator never enrolled — and with it `confidence: 'high'` and the
			// looser direct complaint threshold, silencing the yahoo cell's complaint
			// gate with a signal that reads ~0 forever (the confident wrong signal
			// D14 exists to forbid).
			//
			// A report may therefore CONFIRM and REFRESH an enrollment, never create
			// one. `not_started` is refused — which is not an error, it is a reason
			// (D2) — so no row is ever written by an internet-triggered path. The
			// step-4 promise ("the first Yahoo complaint that arrives confirms it
			// automatically") is attached to `awaiting_yahoo`, and keeps working.
			if (record.state === 'not_started') return unchanged(record, 'not_submitted');
			// Keep the newest observation; an out-of-order replay must never rewind
			// the clock. A report also silently un-lapses the derived state, because
			// the derived state is a function of exactly this timestamp.
			const lastReportAt = Math.max(record.lastReportAt ?? 0, event.at);
			if (record.state === 'enrolled') {
				// COALESCED (D16): an already-enrolled row is only patched once the
				// liveness timestamp moves by a full coalesce window, so a burst of
				// complaints for one domain is a single write instead of one per report.
				if (lastReportAt - (record.lastReportAt ?? 0) < YAHOO_CFL_REPORT_COALESCE_MS) {
					return unchanged(record, 'report_recorded');
				}
				return { record: { ...record, lastReportAt }, changed: true, reason: 'report_recorded' };
			}
			return {
				record: {
					...record,
					state: 'enrolled',
					enrolledAt: record.enrolledAt ?? event.at,
					lastReportAt,
				},
				changed: true,
				reason: 'report_confirms_enrollment',
			};
		}
		case 'reset': {
			if (record.state === 'not_started' && record.submittedAt === undefined) {
				return unchanged(record, 'nothing_to_reset');
			}
			return { record: { state: 'not_started' }, changed: true, reason: 'reset' };
		}
	}
}

// ── The guided flow ─────────────────────────────────────────────────────────

export const YAHOO_CFL_STEP_IDS = [
	'verify_dkim_domain',
	'submit_enrollment',
	'confirm_enrollment',
	'watch_reports',
] as const;
export type YahooCflStepId = (typeof YAHOO_CFL_STEP_IDS)[number];

export type YahooCflStepStatus = 'blocked' | 'todo' | 'in_progress' | 'done';

export interface YahooCflGuidedStep {
	id: YahooCflStepId;
	title: string;
	/** Exactly what to do. */
	action: string;
	/** How to tell it worked. "Guided" means actionable, not narrated. */
	verification: string;
	status: YahooCflStepStatus;
	link?: string;
}

/**
 * The four steps, each with its own "how to tell it worked". Statuses are
 * derived, never stored, so the guide can never disagree with the record.
 */
export function yahooCflGuidedSteps(
	record: YahooCflEnrollmentRecord,
	precondition: YahooCflDkimPrecondition,
	nowMs: number
): YahooCflGuidedStep[] {
	const dkimReady = yahooCflPreconditionMet(precondition);
	const submitted = record.state !== 'not_started';
	const { state } = deriveYahooCflState(record, nowMs);
	const enrolled = state === 'enrolled';
	const lapsed = state === 'lapsed';
	// "Has a complaint arrived FOR THE CURRENT SUBMISSION" — not "was one ever
	// seen". A re-submitted lapsed record deliberately KEEPS `lastReportAt`
	// (it is observed history the liveness verdict still needs), so keying this
	// step on its mere existence would render the fourth step `done` — ahead of
	// the third — and claim complaints are flowing for an enrollment we stopped
	// believing was live one click ago. Comparing against `submittedAt` makes a
	// re-submitted record fall through exactly like any other `awaiting_yahoo`
	// one.
	const reportedSinceSubmission =
		record.lastReportAt !== undefined &&
		(record.submittedAt === undefined || record.lastReportAt >= record.submittedAt);
	const waitedTooLong =
		record.state === 'awaiting_yahoo' &&
		record.submittedAt !== undefined &&
		nowMs - record.submittedAt >= YAHOO_CFL_SUBMISSION_PATIENCE_MS;

	return [
		{
			id: 'verify_dkim_domain',
			title: 'Verify the DKIM domain you sign Yahoo mail with',
			action: `Publish the DKIM record for ${precondition.domain} and wait for the domain to reach "verified".`,
			verification: dkimReady
				? `${precondition.domain} is verified and signing with selector "${precondition.dkimSelector ?? ''}".`
				: 'The domain page shows "verified" and lists a DKIM selector. Yahoo will not accept an enrollment before that.',
			status: dkimReady ? 'done' : 'todo',
		},
		{
			id: 'submit_enrollment',
			title: "Submit Yahoo's Complaint Feedback Loop form",
			action: lapsed
				? `Re-submit the form for ${precondition.domain} at Yahoo's sender site, then press "I submitted Yahoo's form" again.`
				: `Enroll the DKIM domain ${precondition.domain} at Yahoo's sender site and give the FBL address you already receive ARF reports on.`,
			verification:
				'Yahoo emails a confirmation to the address on the form. Keep it — it names the exact domain that was accepted.',
			// A lapsed enrollment reopens this step: re-submitting is the documented
			// remedy, and the affordance is live again (`yahooCflAvailableActions`).
			status: !dkimReady ? 'blocked' : lapsed ? 'todo' : submitted ? 'done' : 'todo',
			link: YAHOO_CFL_ENROLLMENT_URL,
		},
		{
			id: 'confirm_enrollment',
			title: 'Confirm Yahoo accepted the domain',
			action: waitedTooLong
				? `Yahoo has not confirmed in ${inDays(YAHOO_CFL_SUBMISSION_PATIENCE_MS)} days. Re-submit the form — a submission that was never acknowledged is the usual cause.`
				: "Mark the enrollment confirmed once Yahoo's acceptance mail arrives.",
			verification:
				'The first Yahoo complaint that arrives confirms it automatically — you do not have to wait for it to mark this done.',
			status: record.state === 'enrolled' ? 'done' : submitted ? 'in_progress' : 'blocked',
		},
		{
			id: 'watch_reports',
			title: 'Watch complaints arrive',
			action: lapsed
				? "Re-check the enrollment at Yahoo's sender site — a dropped enrollment is the usual cause of a long silence."
				: 'Nothing to do. Yahoo complaints land through the same ARF pipeline as every other feedback loop.',
			verification: lapsed
				? `No Yahoo complaint has arrived in ${inDays(YAHOO_CFL_LAPSE_SILENCE_MS)} days. The enrollment may have been dropped — re-check it at Yahoo.`
				: reportedSinceSubmission
					? 'Yahoo complaints are being attributed to this domain.'
					: 'A Yahoo complaint will appear on the delivery screens with source "yahoo".',
			status: lapsed
				? 'todo'
				: reportedSinceSubmission
					? 'done'
					: enrolled
						? 'in_progress'
						: 'blocked',
		},
	];
}

/**
 * WHICH CONTROLS THE GUIDED FLOW OFFERS RIGHT NOW.
 *
 * Lives in the pure core next to the state machine on purpose: an affordance is
 * only correct if it agrees with what `applyYahooCflEvent` will actually do, and
 * the one way to guarantee that is to derive both from the same place. A UI that
 * re-derived it would be a second definition free to drift — and a control that
 * fires a refused transition is a dead control (it changes nothing and, since a
 * refusal is a reason rather than a throw, says nothing either).
 *
 * `submitBlockedByDkim` is deliberately separate from `canSubmit`: the control is
 * still SHOWN when the DKIM precondition is unmet, so the flow can explain why it
 * is not yet usable instead of hiding the step.
 */
export interface YahooCflAvailableActions {
	/** Offer "I submitted Yahoo's form" — `not_started` or a lapsed enrollment. */
	canSubmit: boolean;
	/** Submit is shown but not yet usable: Yahoo cannot see our signature yet. */
	submitBlockedByDkim: boolean;
	/** Offer "Yahoo accepted the domain" — a submission is awaiting acceptance. */
	canConfirm: boolean;
	/** Offer "Start over" — anything at all has been recorded. */
	canReset: boolean;
}

export function yahooCflAvailableActions(
	record: YahooCflEnrollmentRecord,
	precondition: YahooCflDkimPrecondition,
	nowMs: number
): YahooCflAvailableActions {
	const { state } = deriveYahooCflState(record, nowMs);
	const canSubmit = state === 'not_started' || state === 'lapsed';
	return {
		canSubmit,
		submitBlockedByDkim: canSubmit && !yahooCflPreconditionMet(precondition),
		canConfirm: state === 'awaiting_yahoo',
		// Mirrors the `nothing_to_reset` refusal exactly, so the control is never
		// offered for a record `reset` would decline to touch.
		canReset: !(record.state === 'not_started' && record.submittedAt === undefined),
	};
}
