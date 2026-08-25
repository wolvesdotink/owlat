/**
 * Exclusion rules: retractions, vouch revocations and the appeal cycle of plan
 * §9.3, plus the standing consequences that cycle produces.
 *
 * Every rule requires the record to come from the party entitled to file it.
 * Appeals in particular are a weapon if that is not enforced: the appellant
 * must be the subject *and* the author (DNS-proved domain control is expressed
 * on the log as authorship), appeals are rate-limited per subject, one
 * contested attestation can only be appealed once, an observer that lets the
 * response window lapse takes a standing hit, and an appellant the observer
 * substantiates against takes one too.
 *
 * KNOWN §9.3 GAP: "a pattern of appeals that fail on sampling" is scored here
 * as a plain count of substantiated-against appeals; challenge sampling itself
 * (§7.2.4) is not modelled by this package, so the policy cannot distinguish an
 * appeal that failed on evidence from one the observer merely answered.
 */

import type {
	AppealBody,
	LogEntryRef,
	ResponseBody,
	RetractionBody,
	SubjectRef,
	VouchRevokeBody,
} from '../types.js';
import { daysBetween, parseTimestamp } from './math.js';
import { POLICY_V1 } from './policy.js';
import {
	bodyOf,
	entryKey,
	normalizeSubject,
	observerKey,
	refKey,
	sameParty,
	type MergedEntry,
} from './select.js';

/**
 * Identity coordinates that must not be scored, and what the appeal cycle cost
 * whom. Both counters are per *appeal*, never per contested attestation — see
 * {@link applyAppeal}.
 */
export interface ExclusionResult {
	excluded: Set<string>;
	/** Observer key → appeals against its attestations that it never answered. */
	unansweredAppeals: Map<string, number>;
	/** Appellant key → its appeals a named observer substantiated. */
	failedAppeals: Map<string, number>;
}

/**
 * Every coordinate an entry holds resolves to that entry, so a record naming a
 * cross-submitted copy (spec §5.5) reaches the same attestation the merge kept.
 * Without it, filing a retraction against the copy on the second log would
 * silently do nothing.
 */
function indexByRef(ordered: readonly MergedEntry[]): Map<string, MergedEntry> {
	const byRef = new Map<string, MergedEntry>();
	for (const entry of ordered) {
		for (const ref of entry.refs) byRef.set(refKey(ref), entry);
	}
	return byRef;
}

/**
 * The identity coordinate of whatever `ref` names, so that every rule keys on
 * one attestation rather than on the copy the filer happened to cite. An
 * unknown reference keeps its own key: it names nothing in this evidence set,
 * and inventing a match for it would be worse than leaving it inert.
 */
function resolveKey(byRef: ReadonlyMap<string, MergedEntry>, ref: LogEntryRef): string {
	const target = byRef.get(refKey(ref));
	return target === undefined ? refKey(ref) : entryKey(target);
}

function bump(counter: Map<string, number>, key: string): void {
	counter.set(key, (counter.get(key) ?? 0) + 1);
}

/** Stable identity of an appellant, for rate limiting and standing. */
function partyKey(subject: SubjectRef): string {
	const normalized = normalizeSubject(subject);
	return normalized.domain ?? (normalized.ip === undefined ? '' : `ip:${normalized.ip}`);
}

/**
 * Appeals in chronological order, ties broken by policy order, so the rolling
 * rate limit sees the sequence the log actually recorded.
 */
function appealsInOrder(ordered: readonly MergedEntry[]): MergedEntry[] {
	return ordered
		.filter((entry) => entry.attestation.kind === 'appeal')
		.map((entry, position) => ({ entry, at: parseTimestamp(entry.loggedAt) ?? 0, position }))
		.sort((a, b) => (a.at === b.at ? a.position - b.position : a.at - b.at))
		.map((item) => item.entry);
}

/** Responses indexed `appealKey observerKey outcome`. */
function collectResponses(
	ordered: readonly MergedEntry[],
	byRef: ReadonlyMap<string, MergedEntry>
): Map<string, string[]> {
	const responses = new Map<string, string[]>();
	for (const entry of ordered) {
		if (entry.attestation.kind !== 'response') continue;
		const body = bodyOf<ResponseBody>(entry.attestation);
		const appeal = resolveKey(byRef, body.appeal);
		const key = `${appeal} ${observerKey(entry.attestation.observer)} ${body.outcome}`;
		const at = responses.get(key);
		if (at) at.push(entry.loggedAt);
		else responses.set(key, [entry.loggedAt]);
	}
	return responses;
}

function answeredWithin(
	responses: ReadonlyMap<string, string[]>,
	appealRef: string,
	observer: string,
	outcome: ResponseBody['outcome'],
	appealedAt: string
): boolean {
	const timestamps = responses.get(`${appealRef} ${observer} ${outcome}`);
	if (timestamps === undefined) return false;
	return timestamps.some(
		(at) => daysBetween(appealedAt, at) <= POLICY_V1.appeals.responseWindowDays
	);
}

/** Absolute separation in days; the rate window is symmetric in time. */
function daysApart(a: string, b: string): number {
	const left = parseTimestamp(a);
	const right = parseTimestamp(b);
	if (left === undefined || right === undefined) return Number.POSITIVE_INFINITY;
	const delta = (left - right) / 86_400_000;
	return delta < 0 ? -delta : delta;
}

/**
 * Rate limiter (plan §9.3, §10 "appeal flooding"). An appeal is admissible only
 * if the appellant has filed fewer than `maxPerSubjectPerWindow` admissible
 * appeals inside `rateWindowDays`; the surplus is inert, so re-appealing the
 * same evidence cannot restart an observer's clock indefinitely.
 */
class AppealBudget {
	private readonly filed = new Map<string, string[]>();

	admit(appellant: string, loggedAt: string): boolean {
		const history = this.filed.get(appellant) ?? [];
		const recent = history.filter(
			(at) => daysApart(at, loggedAt) <= POLICY_V1.appeals.rateWindowDays
		).length;
		if (recent >= POLICY_V1.appeals.maxPerSubjectPerWindow) return false;
		history.push(loggedAt);
		this.filed.set(appellant, history);
		return true;
	}
}

interface AppealContext {
	byRef: ReadonlyMap<string, MergedEntry>;
	responses: ReadonlyMap<string, string[]>;
	/** `appellant|attestationKey` pairs already spent; one attestation, one appeal. */
	spent: Set<string>;
	asOf: string;
	result: ExclusionResult;
}

/**
 * Apply one admissible appeal: exclude what it wins, and charge the standing
 * consequences of the cycle (plan §9.3).
 *
 * Evidence is decided per contested attestation, but standing is charged per
 * *appeal*. An appeal that names forty of one observer's attestations is still
 * one demand on that observer's time, so it costs at most one lapse — otherwise
 * the §7.2 first-lapse grace evaporates on the first wide filing, and a flagged
 * sender that controls its own domain could crater a volunteer observer's
 * global standing with a single filing inside the per-subject rate limit (which
 * caps filings, not references per filing). The mirror rule applies to the
 * appellant: one filing the observer substantiates is one failed appeal,
 * whatever it listed.
 */
function applyAppeal(appeal: MergedEntry, context: AppealContext): void {
	const body = bodyOf<AppealBody>(appeal.attestation);
	const appealKey = entryKey(appeal);
	const appellant = partyKey(appeal.attestation.subject);
	const windowElapsed =
		daysBetween(appeal.loggedAt, context.asOf) > POLICY_V1.appeals.responseWindowDays;
	const lapsed = new Set<string>();
	let substantiated = false;

	for (const contested of body.contested) {
		const target = context.byRef.get(refKey(contested));
		if (target === undefined) continue;
		// Only the accused party may appeal, and only inside the retention window.
		if (!sameParty(target.attestation.subject, appeal.attestation.subject)) continue;
		if (daysBetween(target.loggedAt, appeal.loggedAt) > POLICY_V1.appeals.filingWindowDays)
			continue;
		const targetKey = entryKey(target);
		const spentKey = `${appellant}|${targetKey}`;
		if (context.spent.has(spentKey)) continue;
		context.spent.add(spentKey);

		const observer = observerKey(target.attestation.observer);
		if (answeredWithin(context.responses, appealKey, observer, 'retracted', appeal.loggedAt)) {
			context.result.excluded.add(targetKey);
			continue;
		}
		if (answeredWithin(context.responses, appealKey, observer, 'substantiated', appeal.loggedAt)) {
			substantiated = true;
			continue;
		}
		if (!windowElapsed) continue;
		context.result.excluded.add(targetKey);
		lapsed.add(observer);
	}

	for (const observer of lapsed) bump(context.result.unansweredAppeals, observer);
	if (substantiated) bump(context.result.failedAppeals, appellant);
}

/**
 * Coordinates whose attestations must not be scored, and the standing events
 * the appeal cycle produced:
 *  - `retraction` supersedes its target when filed by the target's own observer
 *    (otherwise anyone could erase anyone's evidence).
 *  - `vouch-revoke` cancels a vouch when filed by the voucher.
 *  - `appeal` excludes the contested attestations when the appellant is their
 *    subject and authored the appeal itself, the appeal was filed inside the
 *    retention window and within the appellant's rate budget, and either the
 *    named observer answered `retracted` or the response window has elapsed at
 *    `asOf` with no answer at all.
 */
export function collectExclusions(ordered: readonly MergedEntry[], asOf: string): ExclusionResult {
	const byRef = indexByRef(ordered);

	const result: ExclusionResult = {
		excluded: new Set<string>(),
		unansweredAppeals: new Map<string, number>(),
		failedAppeals: new Map<string, number>(),
	};

	for (const entry of ordered) {
		const { kind } = entry.attestation;
		const author = observerKey(entry.attestation.observer);
		if (kind === 'retraction') {
			const target = byRef.get(refKey(bodyOf<RetractionBody>(entry.attestation).supersedes));
			if (target && observerKey(target.attestation.observer) === author) {
				result.excluded.add(entryKey(target));
			}
			continue;
		}
		if (kind !== 'vouch-revoke') continue;
		const target = byRef.get(refKey(bodyOf<VouchRevokeBody>(entry.attestation).vouch));
		if (
			target &&
			target.attestation.kind === 'vouch' &&
			observerKey(target.attestation.observer) === author
		) {
			result.excluded.add(entryKey(target));
		}
	}

	const context: AppealContext = {
		byRef,
		responses: collectResponses(ordered, byRef),
		spent: new Set<string>(),
		asOf,
		result,
	};
	const budget = new AppealBudget();
	for (const appeal of appealsInOrder(ordered)) {
		// The appellant must have authored its own appeal: filing in someone
		// else's name would let a stranger burn a victim's appeal budget and
		// impose unbounded challenge work on the observer it names.
		if (!sameParty(appeal.attestation.subject, { domain: appeal.attestation.observer })) continue;
		if (!budget.admit(partyKey(appeal.attestation.subject), appeal.loggedAt)) continue;
		applyAppeal(appeal, context);
	}
	return result;
}
