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
			if (!yahooCflPreconditionMet(precondition)) {
				return unchanged(record, 'dkim_domain_not_ready');
			}
			if (record.state === 'enrolled') return unchanged(record, 'already_enrolled');
			return {
				record: {
					...record,
					state: 'awaiting_yahoo',
					dkimDomain: precondition.domain,
					submittedAt: event.at,
				},
				changed: true,
				reason: record.state === 'awaiting_yahoo' ? 'resubmitted' : 'submitted',
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
			// A report is ground truth: it proves Yahoo is sending us CFL mail for
			// this domain regardless of what the operator told us. Keep the newest
			// observation; an out-of-order replay must never rewind the clock. A
			// report also silently un-lapses the derived state, because the derived
			// state is a function of exactly this timestamp.
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
			action: `Enroll the DKIM domain ${precondition.domain} at Yahoo's sender site and give the FBL address you already receive ARF reports on.`,
			verification:
				'Yahoo emails a confirmation to the address on the form. Keep it — it names the exact domain that was accepted.',
			status: !dkimReady ? 'blocked' : submitted ? 'done' : 'todo',
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
				: record.lastReportAt !== undefined
					? 'Yahoo complaints are being attributed to this domain.'
					: 'A Yahoo complaint will appear on the delivery screens with source "yahoo".',
			status: lapsed
				? 'todo'
				: record.lastReportAt !== undefined
					? 'done'
					: enrolled
						? 'in_progress'
						: 'blocked',
		},
	];
}

// ── The complaint-gate substitution (D2 / P3-8) ─────────────────────────────

/**
 * Which complaint signal the `yahoo` cell's gate 3 is actually running on.
 * ONE complaint pipeline, three sources — this names which one is live.
 */
export const YAHOO_COMPLAINT_SIGNAL_SOURCES = [
	'yahoo_cfl',
	'cfbl_address',
	'unsubscribe_rate_proxy',
] as const;
export type YahooComplaintSignalSource = (typeof YAHOO_COMPLAINT_SIGNAL_SOURCES)[number];

/** Direct complaint evidence: the shipped 0.1% complaint-rate threshold. */
export const YAHOO_CFL_COMPLAINT_THRESHOLD = 0.001;

/**
 * The proxy threshold when no complaint feed exists at all. An unsubscribe is a
 * much weaker, much more common signal than a spam report, so the equivalent
 * trip point is TIGHTENED to 0.05% rather than reused at 0.1%.
 */
export const YAHOO_UNSUBSCRIBE_PROXY_THRESHOLD = 0.0005;

export interface YahooComplaintSubstitution {
	source: YahooComplaintSignalSource;
	/** The rate at or above which gate 3 fails for the yahoo cell. */
	thresholdRate: number;
	confidence: 'high' | 'medium' | 'low';
	/**
	 * Plain-language caveat shown on the cell. Present whenever confidence is
	 * below `high`; it is a CAVEAT, never a warning and never a nag.
	 */
	caveat?: string;
	/**
	 * Always `false`. Encoded as a field rather than left implicit so the D2
	 * invariant is asserted by a test rather than assumed by a reader.
	 */
	isBlocking: false;
}

/**
 * Pick the live complaint source for the yahoo cell.
 *
 * Enrollment present → Yahoo's own CFL (high confidence). Otherwise fall back
 * to the RFC 9477 CFBL-Address feed when the send carried one (medium), and
 * failing that to the unsubscribe-rate proxy at the tightened threshold (low,
 * with the caveat spelled out). There is no fourth branch: the gate ALWAYS has
 * a source, so absence can never surface as an error or an unresolvable warning.
 *
 * A `lapsed` enrollment is treated exactly like no enrollment — the point of the
 * derived lapse is that we can no longer trust the feed to be live.
 *
 * SCOPE NOTE (D3): P3-8 owns the ONE substitution table for every gate. When it
 * lands it SUBSUMES this function, and `YAHOO_CFL_COMPLAINT_THRESHOLD` /
 * `YAHOO_UNSUBSCRIBE_PROXY_THRESHOLD` move into it — they must not be
 * re-declared there, or the controller and this wizard would end up with two
 * disagreeing definitions of the yahoo complaint gate. Until then this is the
 * only definition, and it exists so the wizard can state the live source
 * honestly rather than showing a blank gate.
 */
export function yahooComplaintSubstitution(input: {
	enrollmentState: YahooCflEnrollmentState;
	hasCfblAddress: boolean;
}): YahooComplaintSubstitution {
	if (input.enrollmentState === 'enrolled') {
		return {
			source: 'yahoo_cfl',
			thresholdRate: YAHOO_CFL_COMPLAINT_THRESHOLD,
			confidence: 'high',
			isBlocking: false,
		};
	}
	if (input.hasCfblAddress) {
		return {
			source: 'cfbl_address',
			thresholdRate: YAHOO_CFL_COMPLAINT_THRESHOLD,
			confidence: 'medium',
			caveat:
				'Measurement confidence: medium — Yahoo complaints are counted from the CFBL-Address feed. Enrolling this domain in Yahoo’s Complaint Feedback Loop would measure them directly.',
			isBlocking: false,
		};
	}
	return {
		source: 'unsubscribe_rate_proxy',
		thresholdRate: YAHOO_UNSUBSCRIBE_PROXY_THRESHOLD,
		confidence: 'low',
		caveat:
			'Measurement confidence: low — no Yahoo complaint feed, so unsubscribes stand in for complaints at a tighter threshold. Enrolling this domain in Yahoo’s Complaint Feedback Loop would measure complaints directly.',
		isBlocking: false,
	};
}
