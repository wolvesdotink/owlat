/**
 * Evidence extraction: the admitted entries for one subject, folded into
 * per-observer aggregates the signal functions consume (plan §6.2).
 *
 * Admissibility, not just weight, is decided here:
 *  - Observed evidence (traffic, reports, traps) authored by the subject itself
 *    or by anything sharing its registrable domain is dropped. Self-assertion
 *    belongs in `posture`, which is bounded; letting it into the observed
 *    signals would let one wildcard DNS record buy `trusted` (plan §6.1, §7.3).
 *    The deliberate cost: an ESP observing `customer.esp.example` is scored as
 *    the same party as its customer and contributes nothing to that customer's
 *    standing, even though plan D3 gives the customer separate standing. Being
 *    wrong in that direction only ever withholds credit.
 *  - A `spam-report-batch` counts only alongside its own author's
 *    traffic-summary for an overlapping window, and its rate is measured
 *    against that author's own volume (plan §7.3): under-attesting volume now
 *    shrinks the attacker's denominator, not the subject's.
 *  - Only the subject's own `posture` is read (plan §5).
 *
 * Negative evidence — and the volume it is measured against — is decayed here,
 * at extraction time, against the caller's `asOf`; the policy never reads a
 * clock. Map insertion order follows the policy's total entry order, so every
 * derived iteration is deterministic.
 *
 * Observed history is anchored to the log's clock, not to the author's window:
 * see {@link resolveHistory}. Everything else an author publishes is a claim
 * about the present that its peers can contradict; a claim about the past is
 * contradicted by nothing, so it is bounded by the only past the log can prove.
 *
 * Self-dealing is undetectable for a bare-IP subject: an IP has no author
 * identity to compare against. Bare-IP evidence is therefore always treated as
 * third-party, which is why posture is not scored for IP subjects at all.
 */

import type {
	LogEntryRef,
	PostureBody,
	SequencedAttestation,
	SpamReportBatchBody,
	TrafficSummaryBody,
	TrapHitBody,
	VouchBody,
} from '../types.js';
import {
	clamp,
	daysBetween,
	daysBetweenMs,
	halfLifeFactor,
	isAtOrBefore,
	parseTimestamp,
} from './math.js';
import { normalizeDomain, observerKey, registrableDomain, type MergedEntry } from './select.js';
import { POLICY_V1 } from './policy.js';

/** Half-open window an attestation covers, in epoch milliseconds. */
interface Interval {
	from: number;
	to: number;
}

/** One traffic summary's contribution to its observer's aggregate. */
interface Summary extends Interval {
	messages: number;
}

/** Per-observer traffic aggregate, summed over that observer's own summaries. */
export interface ObserverTraffic {
	messages: number;
	spfPass: number;
	dkimPass: number;
	dmarcPass: number;
	/** Σ messages × clamped bounce bucket: the observer's own bounce mass. */
	bounceMass: number;
	/** Σ messages × decay, i.e. the numerator of the volume-weighted decay factor. */
	decayedMessages: number;
	/** Earliest window start this observer claimed, in epoch milliseconds. */
	claimedFromMs: number;
	/** Earliest `loggedAt` this observer has about the subject, in epoch milliseconds. */
	loggedFromMs: number;
	/** Days of history this observer can prove; see {@link resolveHistory}. */
	historyDays: number;
	/** This observer's summaries, for report-batch admissibility (plan §7.3). */
	summaries: Summary[];
}

/** Per-observer decayed magnitude of one negative evidence kind. */
export interface NegativeAggregate {
	byObserver: Map<string, number>;
	total: number;
	refs: LogEntryRef[];
}

/** One observer's complaint evidence, and the volume it is measured against. */
export interface ObserverReports {
	/** Reports as published, undecayed: the numerator of this observer's rate. */
	reports: number;
	/** Σ reports × decay, so the *contribution* ages even though the rate does not. */
	decayed: number;
	/** This observer's attested volume over the windows it reported on. */
	volume: number;
}

export interface ReportAggregate {
	byObserver: Map<string, ObserverReports>;
	refs: LogEntryRef[];
}

export interface PostureFact {
	observer: string;
	body: PostureBody;
	refs: readonly LogEntryRef[];
}

export interface VouchFact {
	observer: string;
	refs: readonly LogEntryRef[];
}

export interface SubjectFacts {
	traffic: Map<string, ObserverTraffic>;
	trafficRefs: LogEntryRef[];
	totalMessages: number;
	totalSpfPass: number;
	totalDkimPass: number;
	totalDmarcPass: number;
	reports: ReportAggregate;
	traps: NegativeAggregate;
	posture: PostureFact | undefined;
	vouches: VouchFact[];
}

/**
 * Age reference of an attestation: the end of its window when that window has
 * closed at `asOf`, else the log's inclusion time.
 *
 * Spec §2.4 lets `window.to` speak for decay only because a window ending after
 * `asOf` is inadmissible; `orderEntries` drops those entries before extraction.
 * The fallback is the second lock on that door: for a window dated into the
 * future `daysBetween` floors at 0 and the half-life factor at 1, so an author
 * would buy undecayed negative evidence. `loggedAt` prices it at the only
 * instant the log signed.
 */
function evidenceTime(entry: SequencedAttestation, asOf: string): string {
	const closesAt = entry.attestation.window?.to;
	return closesAt !== undefined && isAtOrBefore(closesAt, asOf) ? closesAt : entry.loggedAt;
}

function decayOf(entry: SequencedAttestation, asOf: string): number {
	return halfLifeFactor(
		daysBetween(evidenceTime(entry, asOf), asOf),
		POLICY_V1.negativeHalfLifeDays
	);
}

/** The window an entry covers; a windowless entry covers the instant it was logged. */
function intervalOf(entry: SequencedAttestation): Interval | undefined {
	const logged = parseTimestamp(entry.loggedAt);
	const window = entry.attestation.window;
	const from = window === undefined ? logged : parseTimestamp(window.from);
	const to = window === undefined ? logged : parseTimestamp(window.to);
	if (from === undefined || to === undefined) return undefined;
	return from <= to ? { from, to } : { from: to, to: from };
}

function overlaps(a: Interval, b: Interval): boolean {
	return a.from <= b.to && b.from <= a.to;
}

function emptyNegative(): NegativeAggregate {
	return { byObserver: new Map(), total: 0, refs: [] };
}

function addNegative(
	aggregate: NegativeAggregate,
	observer: string,
	amount: number,
	refs: readonly LogEntryRef[]
): void {
	if (!(amount > 0)) return;
	aggregate.byObserver.set(observer, (aggregate.byObserver.get(observer) ?? 0) + amount);
	aggregate.total += amount;
	aggregate.refs.push(...refs);
}

function emptyTraffic(): ObserverTraffic {
	return {
		messages: 0,
		spfPass: 0,
		dkimPass: 0,
		dmarcPass: 0,
		bounceMass: 0,
		decayedMessages: 0,
		claimedFromMs: Number.POSITIVE_INFINITY,
		loggedFromMs: Number.POSITIVE_INFINITY,
		historyDays: 0,
		summaries: [],
	};
}

/** Non-negative finite reading of a body counter; anything else reads as 0. */
function count(value: number | undefined): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Pass counts are capped at the message count — a summary cannot pass more mail than it saw. */
function passes(value: number | undefined, messages: number): number {
	return Math.min(count(value), messages);
}

/**
 * A published bounce bucket, clamped into the encoding the policy declares.
 * An observer that publishes `-1e9` or `1e6` moves the signal by exactly as
 * much as the worst honest reading, and no further.
 */
function bounceBucket(value: number | undefined): number {
	const { freeBucket, saturationBucket } = POLICY_V1.bounce;
	return clamp(count(value), freeBucket, saturationBucket);
}

/** True when `observer` is the subject, or is controlled by whoever controls it. */
function selfDealing(observer: string, subjectDomain: string | undefined): boolean {
	if (subjectDomain === undefined) return false;
	return registrableDomain(observer) === registrableDomain(subjectDomain);
}

function foldTrafficSummary(facts: SubjectFacts, entry: MergedEntry, asOf: string): void {
	const body = entry.attestation.body as TrafficSummaryBody;
	const messages = count(body.messages);
	if (messages === 0) return;
	const observer = observerKey(entry.attestation.observer);
	const spfPass = passes(body.spfPass, messages);
	const dkimPass = passes(body.dkimPass, messages);
	const dmarcPass = passes(body.dmarcPass, messages);
	const aggregate = facts.traffic.get(observer) ?? emptyTraffic();
	aggregate.messages += messages;
	aggregate.spfPass += spfPass;
	aggregate.dkimPass += dkimPass;
	aggregate.dmarcPass += dmarcPass;
	aggregate.bounceMass += messages * bounceBucket(body.bounceRateBucket);
	aggregate.decayedMessages += messages * decayOf(entry, asOf);

	// Instants are compared, never the strings — `2020-01-02T00:00:00+05:00`
	// precedes `2020-01-01T23:00:00Z` chronologically but not lexically.
	const loggedMs = parseTimestamp(entry.loggedAt);
	if (loggedMs !== undefined && loggedMs < aggregate.loggedFromMs) {
		aggregate.loggedFromMs = loggedMs;
	}
	const interval = intervalOf(entry);
	if (interval !== undefined) {
		aggregate.summaries.push({ ...interval, messages });
		// History is per observer: an observer vouches only for the span it
		// witnessed itself, so one backdated summary cannot age a whole subject.
		if (interval.from < aggregate.claimedFromMs) aggregate.claimedFromMs = interval.from;
	}

	facts.traffic.set(observer, aggregate);
	facts.trafficRefs.push(...entry.refs);
	facts.totalMessages += messages;
	facts.totalSpfPass += spfPass;
	facts.totalDkimPass += dkimPass;
	facts.totalDmarcPass += dmarcPass;
}

/**
 * Fold one report batch (plan §7.3).
 *
 * The batch counts only if its own author attested traffic for an overlapping
 * window; the reported intervals are remembered so the denominator can be
 * restricted to exactly the volume that author attested for the periods it
 * complained about. Attesting no volume — the strictly better move for an
 * attacker under a shared denominator — now yields nothing at all.
 */
function foldReportBatch(
	facts: SubjectFacts,
	entry: MergedEntry,
	observer: string,
	asOf: string,
	reported: Map<string, Interval[]>
): void {
	const traffic = facts.traffic.get(observer);
	if (traffic === undefined) return;
	const interval = intervalOf(entry);
	if (interval === undefined) return;
	if (!traffic.summaries.some((summary) => overlaps(summary, interval))) return;
	const reports = count((entry.attestation.body as SpamReportBatchBody).reports);
	if (reports === 0) return;

	const aggregate = facts.reports.byObserver.get(observer) ?? { reports: 0, decayed: 0, volume: 0 };
	aggregate.reports += reports;
	aggregate.decayed += reports * decayOf(entry, asOf);
	facts.reports.byObserver.set(observer, aggregate);
	facts.reports.refs.push(...entry.refs);
	reported.set(observer, [...(reported.get(observer) ?? []), interval]);
}

/**
 * The denominator of each observer's complaint rate: the volume that observer
 * attested for windows it actually reported on. Each summary counts once,
 * however many batches overlap it, and volume from unreported periods is not
 * counted at all — a rate must describe one period, not a decade of history
 * divided into last month's complaints.
 */
function resolveReportedVolume(
	facts: SubjectFacts,
	reported: ReadonlyMap<string, Interval[]>
): void {
	for (const [observer, intervals] of reported) {
		const traffic = facts.traffic.get(observer);
		const aggregate = facts.reports.byObserver.get(observer);
		if (traffic === undefined || aggregate === undefined) continue;
		for (const summary of traffic.summaries) {
			if (intervals.some((interval) => overlaps(summary, interval))) {
				aggregate.volume += summary.messages;
			}
		}
	}
}

function foldPosture(
	facts: SubjectFacts,
	entry: MergedEntry,
	subjectDomain: string | undefined
): void {
	// Posture is a self-declaration (plan §5): only the subject may publish it,
	// and only about a domain. A bare-IP subject has no author to check, so it
	// gets no posture at all — an IP's configuration reaches the score through
	// the domain that declared it (plan D2).
	if (subjectDomain === undefined) return;
	if (normalizeDomain(entry.attestation.subject.domain) !== subjectDomain) return;
	if (observerKey(entry.attestation.observer) !== subjectDomain) return;
	// Last self-authored posture in policy order wins: posture is a
	// current-state declaration, not accumulating evidence.
	facts.posture = {
		observer: subjectDomain,
		body: entry.attestation.body as PostureBody,
		refs: entry.refs,
	};
}

/**
 * Each observer's provable history span, in days (spec §6.2, plan §6.2).
 *
 * The span starts at the later of the earliest window an observer claimed and
 * the earliest `loggedAt` it holds about this subject: an attestation logged
 * yesterday cannot buy years of history, however far back its `window.from`
 * reaches. Only `loggedAt` is a fact the log signs; `window.from` is
 * author-supplied and, unlike a claim about the present, no peer can contradict
 * it.
 *
 * That anchor is what makes time the expensive signal the plan says it is: a
 * ring of fresh domains that publish a decade of fabricated windows today gets
 * one day of history each, and buying real history means having published on
 * the log, in the open, for the whole span claimed. The cost is borne by an
 * honest observer's first report about a subject, which is worth its logged age
 * rather than its stated window — one reporting period of credit it earns back
 * simply by continuing to publish.
 */
function resolveHistory(facts: SubjectFacts, asOf: string): void {
	const asOfMs = parseTimestamp(asOf);
	if (asOfMs === undefined) return;
	for (const traffic of facts.traffic.values()) {
		const start = Math.max(traffic.claimedFromMs, traffic.loggedFromMs);
		traffic.historyDays = Number.isFinite(start) ? daysBetweenMs(start, asOfMs) : 0;
	}
}

/**
 * Fold the subject's admitted entries into aggregates.
 *
 * `entries` must already be ordered, deduplicated and filtered to the subject
 * by `selectSubjectEntries`; this function decides which of them are
 * admissible evidence about the subject and how much each weighs.
 *
 * Traffic is folded first because report-batch admissibility depends on it.
 */
export function extractFacts(
	entries: readonly MergedEntry[],
	subjectDomain: string | undefined,
	asOf: string
): SubjectFacts {
	const facts: SubjectFacts = {
		traffic: new Map(),
		trafficRefs: [],
		totalMessages: 0,
		totalSpfPass: 0,
		totalDkimPass: 0,
		totalDmarcPass: 0,
		reports: { byObserver: new Map(), refs: [] },
		traps: emptyNegative(),
		posture: undefined,
		vouches: [],
	};

	for (const entry of entries) {
		if (entry.attestation.kind !== 'traffic-summary') continue;
		if (selfDealing(observerKey(entry.attestation.observer), subjectDomain)) continue;
		foldTrafficSummary(facts, entry, asOf);
	}
	resolveHistory(facts, asOf);

	const reported = new Map<string, Interval[]>();
	for (const entry of entries) {
		const kind = entry.attestation.kind;
		const observer = observerKey(entry.attestation.observer);
		const selfAuthored = selfDealing(observer, subjectDomain);
		switch (kind) {
			case 'spam-report-batch':
				if (!selfAuthored) foldReportBatch(facts, entry, observer, asOf, reported);
				break;
			case 'trap-hit': {
				if (selfAuthored) break;
				const body = entry.attestation.body as TrapHitBody;
				addNegative(facts.traps, observer, count(body.hits) * decayOf(entry, asOf), entry.refs);
				break;
			}
			case 'posture':
				foldPosture(facts, entry, subjectDomain);
				break;
			case 'vouch': {
				// Vouching for yourself stakes nothing (plan §6.4).
				if (selfAuthored) break;
				const body = entry.attestation.body as VouchBody;
				// Expired vouches are ignored; revoked ones never reach this function.
				if (typeof body.expires === 'string' && !isAtOrBefore(body.expires, asOf)) {
					facts.vouches.push({ observer, refs: entry.refs });
				}
				break;
			}
			default:
				break;
		}
	}
	resolveReportedVolume(facts, reported);
	return facts;
}
