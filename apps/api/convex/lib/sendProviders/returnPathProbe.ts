/**
 * The return-path probe state machine (plan G-08).
 *
 * ONE probe, for ONE configured transport, and the timing rules around it:
 * when a probe is due, when an open one has aged out, and what each event does
 * to its state. Split out of `returnPathCapability.ts`, which now holds only
 * the FOLD of a settled probe plus the catalog declaration into the resolved
 * posture the send path and the gates read.
 *
 * The invariant that makes the whole measurement trustworthy lives here:
 * ACCEPTANCE IS NOT A VERDICT. `supported` is reached only from an OBSERVED
 * bounce, because the signed VERP token is the address the DSN is sent to — a
 * relay that rewrote (or merely case-folded) our envelope sender routes the DSN
 * somewhere we never see, so it presents as SILENCE and ages out `unsupported`.
 *
 * Pure module: no db, no clock, no env, no catalog. Every input is a parameter,
 * every function is total — a corrupt row or a skewed clock resolves to
 * "re-probe it", never to a throw and never to a wedged scheduler (plan D2).
 */

/**
 * Lifecycle of ONE return-path probe for ONE configured transport.
 *
 *   awaiting_delivery  the relay accepted our MAIL FROM; nothing proven yet
 *   supported          a bounce for the probe reached OUR bounce server
 *   unsupported        the relay refused our MAIL FROM, the probe aged out
 *                      without a bounce ever arriving (which is how a rewritten
 *                      envelope sender presents — the DSN goes elsewhere), or
 *                      the transport's own adapter cannot put a chosen envelope
 *                      sender on the wire at all
 */
export const RETURN_PATH_PROBE_STATUSES = [
	'awaiting_delivery',
	'supported',
	'unsupported',
] as const;
export type ReturnPathProbeStatus = (typeof RETURN_PATH_PROBE_STATUSES)[number];

/** Why a probe ended where it did. Rendered to operators verbatim. */
export const RETURN_PATH_PROBE_REASONS = [
	'awaiting_delivery',
	'observed_match',
	'rejected_by_relay',
	'no_bounce_observed',
	/**
	 * The transport's OWN adapter has no way to put a caller-chosen
	 * RFC5321.MailFrom on the wire (Mandrill's `return_path_domain` names a
	 * domain; the local part — where the signed probe token lives — is the
	 * provider's). Settled without a send: the answer is about OUR reach into
	 * that transport's envelope, is knowable locally, and spending a deliberate
	 * hard bounce on the operator's ESP account to re-learn it every backoff
	 * cycle would buy nothing. Distinct from `rejected_by_relay` (the relay
	 * ruled on our MAIL FROM and refused it) and from `no_bounce_observed` (we
	 * sent and heard nothing) precisely because neither of those happened.
	 */
	'no_envelope_control',
] as const;
export type ReturnPathProbeReason = (typeof RETURN_PATH_PROBE_REASONS)[number];

/**
 * The subsets a SETTLED verdict may carry. `awaiting_delivery` is the status
 * and reason of a probe still in flight, so a settled verdict admits neither —
 * derived here rather than re-listed so a literal added above cannot drift out
 * of the subsets, or out of the table validators that consume both
 * (`schema/returnPath.ts`).
 */
export const SETTLED_RETURN_PATH_PROBE_STATUSES = RETURN_PATH_PROBE_STATUSES.filter(
	(status): status is Exclude<ReturnPathProbeStatus, 'awaiting_delivery'> =>
		status !== 'awaiting_delivery'
);

export const SETTLED_RETURN_PATH_PROBE_REASONS = RETURN_PATH_PROBE_REASONS.filter(
	(reason): reason is Exclude<ReturnPathProbeReason, 'awaiting_delivery'> =>
		reason !== 'awaiting_delivery'
);

/**
 * A verdict a probe already reached, carried across a later RE-PROBE.
 *
 * A re-probe reopens the row (`awaiting_delivery`), and an open probe resolves
 * to `unknown` — so without this, a relay PROVEN to honour our return path
 * would stop being stamped for up to {@link RETURN_PATH_PROBE_TIMEOUT_MS} every
 * time its TTL came round: relayed bounces in that window would be
 * unattributable and the cell would silently flip to degraded, twelve times a
 * year. The re-probe periodically switching OFF the very stamp it exists to
 * confirm is the opposite of what it is for.
 */
export interface SettledReturnPathVerdict {
	readonly status: (typeof SETTLED_RETURN_PATH_PROBE_STATUSES)[number];
	readonly reason: (typeof SETTLED_RETURN_PATH_PROBE_REASONS)[number];
	readonly settledAt: number;
}

export interface ReturnPathProbeState {
	readonly status: ReturnPathProbeStatus;
	readonly reason: ReturnPathProbeReason;
	/** The envelope sender we asked the relay to use. */
	readonly sentEnvelopeSender: string;
	/** When the probe was put on the wire. */
	readonly startedAt: number;
	/** When the status last changed. */
	readonly settledAt?: number;
	/**
	 * How many probes this transport has had. Drives the retry BACKOFF: every
	 * probe deliberately manufactures a bounce on the operator's relay, and a
	 * fixed daily retry against a relay that will never support us is one
	 * deliberate hard bounce a day, forever, on an account whose bounce rate can
	 * get the operator suspended. Legacy rows carry no count and are read as 1.
	 *
	 * It counts CONSECUTIVE probes since the last `supported` verdict, not every
	 * probe the transport has ever had — see {@link nextProbeAttempts}. Counting
	 * the latter would push a long-supported relay to the 30d cap, so the day it
	 * broke its documented "1st retry: next day" would in fact be a month.
	 */
	readonly attempts?: number;
	/**
	 * The verdict this transport last SETTLED on, kept while a re-probe is open
	 * so a proven relay keeps its stamp. Replaced (not merged) when the new probe
	 * settles; absent until a first verdict exists.
	 */
	readonly lastSettled?: SettledReturnPathVerdict;
}

export type ReturnPathProbeEvent =
	/** The relay's SMTP conversation accepted (or refused) MAIL FROM. */
	| { readonly kind: 'submitted'; readonly accepted: boolean; readonly at: number }
	/**
	 * A bounce for the probe reached OUR bounce server. Arrival IS the evidence
	 * — the signed VERP token lives in the address the DSN was sent to, so a
	 * relay that rewrote (or merely case-folded) the envelope sender routes the
	 * DSN somewhere else entirely and we observe nothing. There is deliberately
	 * no observed-address payload: no production source could supply one that
	 * differed, so comparing it would be a tautology dressed up as a check.
	 */
	| { readonly kind: 'observed'; readonly at: number }
	/** The probe aged out with nothing observed. */
	| { readonly kind: 'expired'; readonly at: number }
	/**
	 * The transport's adapter declined the probe wire — it cannot express a
	 * chosen envelope sender, so nothing was sent and nothing ever will be for
	 * this kind. A local, deterministic verdict, not an observation.
	 */
	| { readonly kind: 'no_envelope_control'; readonly at: number };

/** How long a probe waits for its bounce before it is called unsupported. */
export const RETURN_PATH_PROBE_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6h

/** How long a settled verdict is trusted before the transport is re-probed. */
export const RETURN_PATH_PROBE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d

/**
 * How soon an UNSUPPORTED verdict is retried, by attempt number.
 *
 * A probe is not free: it deliberately manufactures a bounce ON THE OPERATOR'S
 * RELAY, and a relay's bounce rate is exactly what gets an ESP account
 * suspended. A relay that does not honour a custom return path today usually
 * will not tomorrow either, so retrying it daily forever spends the operator's
 * sender reputation to re-learn a fact we already know. Back off instead:
 * a config change is still detected, just at a cost of one bounce a month
 * rather than 365.
 *
 * The last entry repeats — this is the cap. We never stop entirely, because a
 * transport frozen at `unsupported` forever could never recover from an
 * operator fixing their relay.
 */
export const RETURN_PATH_PROBE_RETRY_SCHEDULE_MS = [
	24 * 60 * 60 * 1000, // 1st retry: next day
	7 * 24 * 60 * 60 * 1000, // 2nd retry: next week
	30 * 24 * 60 * 60 * 1000, // thereafter: monthly (the cap)
] as const;

/** The FIRST retry interval — the shortest wait any unsupported verdict gets. */
export const RETURN_PATH_PROBE_RETRY_MS: number = RETURN_PATH_PROBE_RETRY_SCHEDULE_MS[0];

/** Retry interval for the Nth (1-based) settled attempt. */
export function returnPathProbeRetryMs(attempts: number | undefined): number {
	// ONE normalisation, applied to the argument itself: a missing, non-numeric
	// or non-finite count is the first attempt. (Testing `Number.isFinite` on the
	// possibly-undefined argument made the legacy-row rule hold by accident.)
	const n =
		typeof attempts === 'number' && Number.isFinite(attempts)
			? Math.max(1, Math.trunc(attempts))
			: 1;
	const capped = Math.min(n - 1, RETURN_PATH_PROBE_RETRY_SCHEDULE_MS.length - 1);
	return RETURN_PATH_PROBE_RETRY_SCHEDULE_MS[capped] ?? RETURN_PATH_PROBE_RETRY_MS;
}

/**
 * The verdict a transport currently STANDS ON, whether or not a re-probe is in
 * flight: the row's own status once it has settled, otherwise the verdict it
 * carried into the open probe. `undefined` ⇒ never settled anything.
 */
export function settledVerdictOf(
	state: ReturnPathProbeState | null | undefined
): SettledReturnPathVerdict | undefined {
	if (!state) return undefined;
	if (state.status === 'awaiting_delivery') return state.lastSettled;
	// A settled row cannot legitimately carry the in-flight reason. Rewriting one
	// that does into `no_bounce_observed` would present the operator with a
	// reason the system never observed; reporting NO verdict instead makes the
	// transport read as never-settled, so it is simply re-probed and the answer
	// comes from evidence rather than from laundering a corrupt row.
	if (state.reason === 'awaiting_delivery') return undefined;
	return {
		status: state.status,
		reason: state.reason,
		settledAt: state.settledAt ?? state.startedAt,
	};
}

/**
 * The attempt number a NEW probe for this transport should carry.
 *
 * Counts consecutive probes since the last `supported` verdict: a relay that is
 * currently proven starts over at 1, so if it later breaks it gets the schedule
 * its docstring promises (next day, then next week, then monthly) rather than
 * inheriting a count accumulated over a year of successful TTL re-checks. A
 * non-finite legacy count is read as none.
 */
export function nextProbeAttempts(previous: ReturnPathProbeState | null | undefined): number {
	if (settledVerdictOf(previous)?.status === 'supported') return 1;
	const raw = previous?.attempts;
	const base = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
	return base + 1;
}

/**
 * Advance a probe. Total and deterministic: an event that cannot apply (a late
 * observation for an already-settled probe, an expiry after a verdict) returns
 * the state unchanged rather than throwing.
 */
export function nextProbeState(
	state: ReturnPathProbeState,
	event: ReturnPathProbeEvent
): ReturnPathProbeState {
	if (state.status !== 'awaiting_delivery') return state;

	switch (event.kind) {
		case 'submitted':
			// Acceptance proves nothing on its own — it only keeps the probe open.
			return event.accepted
				? state
				: {
						...state,
						status: 'unsupported',
						reason: 'rejected_by_relay',
						settledAt: event.at,
					};
		case 'observed':
			// THE point of the probe: the DSN came back to the address we set, so
			// the relay preserved our envelope sender. A relay that rewrote it
			// cannot reach here at all — it settles through 'expired' instead.
			return {
				...state,
				status: 'supported',
				reason: 'observed_match',
				settledAt: event.at,
			};
		case 'expired':
			return {
				...state,
				status: 'unsupported',
				reason: 'no_bounce_observed',
				settledAt: event.at,
			};
		case 'no_envelope_control':
			return {
				...state,
				status: 'unsupported',
				reason: 'no_envelope_control',
				settledAt: event.at,
			};
		default: {
			const exhaustive: never = event;
			return exhaustive;
		}
	}
}

/**
 * Elapsed time between two instants, or `null` when either is unusable.
 *
 * A NaN or Infinite timestamp (a corrupt row, a skewed clock, a hand-written
 * fixture) makes every `>=` comparison FALSE, which would wedge the scheduler
 * permanently: the open probe never times out, the transport is never
 * re-probed, and the capability is stuck at `unknown` with no path to recovery.
 * Callers treat `null` as "assume it is due", so a degenerate row heals itself
 * on the next sweep instead of becoming a silent dead end.
 */
function elapsedSince(instant: number, now: number): number | null {
	if (!Number.isFinite(instant) || !Number.isFinite(now)) return null;
	return now - instant;
}

/** Has an open probe waited longer than the timeout? Degenerate ⇒ yes. */
export function isProbeTimedOut(state: ReturnPathProbeState, now: number): boolean {
	if (state.status !== 'awaiting_delivery') return false;
	const elapsed = elapsedSince(state.startedAt, now);
	return elapsed === null || elapsed >= RETURN_PATH_PROBE_TIMEOUT_MS;
}

/**
 * Is it time to (re-)probe this transport? Never probed → yes. Open probe →
 * no (one in flight is enough) until it times out. Supported → after the TTL.
 * Unsupported → after a BACKING-OFF retry interval, because relay configuration
 * does change but each probe costs the operator a real bounce.
 *
 * A degenerate timestamp is due, never wedged (see {@link elapsedSince}).
 */
export function isProbeDue(state: ReturnPathProbeState | null, now: number): boolean {
	if (!state) return true;
	if (state.status === 'awaiting_delivery') return isProbeTimedOut(state, now);
	const elapsed = elapsedSince(state.settledAt ?? state.startedAt, now);
	if (elapsed === null) return true;
	const interval =
		state.status === 'supported'
			? RETURN_PATH_PROBE_TTL_MS
			: returnPathProbeRetryMs(state.attempts);
	return elapsed >= interval;
}
