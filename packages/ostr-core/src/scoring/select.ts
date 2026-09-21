/**
 * Input normalization for the scoring policy: identity (plan D2/D3), total
 * ordering, visibility at `asOf` and subject matching.
 *
 * Everything here is a pure function of its arguments. Ordering is established
 * once, up front, so the rest of the policy never observes the order the caller
 * happened to pass entries in. Identity is normalized once, here, so no later
 * module compares raw strings: an observer that spells itself `Accuser.example`
 * in one attestation and `accuser.example` in the next is one witness, and the
 * §6.3 bounds do not depend on another module having validated the input.
 */

import { canonicalize } from '../jcs.js';
import type {
	Attestation,
	LogEntryRef,
	PostureBody,
	SequencedAttestation,
	SubjectRef,
} from '../types.js';
import { defaultPrefixKey, formatIp, inRange, parseCidr, parseIp, type ParsedCidr } from './ip.js';
import { isAtOrBefore } from './math.js';

/** Stable key for a log coordinate. `logId` cannot contain the separator by construction. */
export function refKey(ref: LogEntryRef): string {
	return `${ref.logId} ${ref.index}`;
}

export function entryKey(entry: SequencedAttestation): string {
	return refKey(entry);
}

export function bodyOf<TBody>(attestation: Attestation): TBody {
	return attestation.body as TBody;
}

/** Lowercased, trailing-dot-stripped domain. `undefined` for blank input. */
export function normalizeDomain(domain: string | undefined): string | undefined {
	if (domain === undefined) return undefined;
	const trimmed = domain.trim().toLowerCase().replace(/\.+$/, '');
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalized identity of an attestation's author. Every map key, entitlement
 * check and observer count in the policy goes through this function; the empty
 * string is the identity of an author that named itself with whitespace, and it
 * groups with itself only.
 */
export function observerKey(observer: string): string {
	return normalizeDomain(observer) ?? '';
}

/**
 * Second-level suffixes under a two-letter ccTLD that behave like a TLD, so
 * `mx.example.co.uk` rolls up to `example.co.uk` rather than to `co.uk`.
 *
 * A heuristic, deliberately: the Public Suffix List is a third-party data set
 * this package may not depend on, and shipping a stale copy of it would be
 * worse than a rule a reader can check by eye. It is used only for *grouping*
 * (diversity counts, per-observer caps, self-dealing detection), never to
 * decide identity — {@link normalizeDomain} does that — so an over-broad group
 * costs an attacker capacity and an under-broad one costs nothing but precision.
 */
const CCTLD_SECOND_LEVEL = new Set([
	'ac',
	'co',
	'com',
	'edu',
	'gov',
	'ltd',
	'me',
	'mil',
	'net',
	'nom',
	'or',
	'org',
	'plc',
	'sch',
	'web',
]);

/**
 * The registrable ("organizational") domain: the label under the public
 * suffix, by the heuristic above. Returns the input unchanged when it has too
 * few labels to reduce.
 */
export function registrableDomain(domain: string): string {
	const labels = domain.split('.').filter((label) => label.length > 0);
	if (labels.length <= 2) return labels.join('.');
	const tld = labels[labels.length - 1] as string;
	const second = labels[labels.length - 2] as string;
	const take = tld.length === 2 && CCTLD_SECOND_LEVEL.has(second) ? 3 : 2;
	if (labels.length <= take) return labels.join('.');
	return labels.slice(labels.length - take).join('.');
}

/**
 * Maps an observer to the identity of the party that controls it, for the
 * bounds that must not be defeated by minting names (§6.3 per-observer cap,
 * §6.2 diversity, §7.3 evidence rings).
 */
export type ObserverGrouper = (observer: string) => string;

/**
 * The v1 grouping: registrable domain. It collapses `mx2.x`, `mx3.x` and
 * `MX4.X.` to one witness — the free half of the problem.
 *
 * What it does NOT judge: shared infrastructure, ASN, or monitor findings about
 * collusion, all of which §6.3 names as inputs to "disjoint control". Two
 * unrelated registrable domains on one host still count as two observers here.
 * That input is owed by the registry/monitor layer, which can supply it through
 * `ScoreSubjectInput.observerGroup` without giving up purity.
 */
export const defaultObserverGroup: ObserverGrouper = (observer) =>
	registrableDomain(observerKey(observer));

/**
 * Canonical IP literal: parsed and re-rendered, so every spelling of one
 * address is one subject (plan D2). Unparseable text is not an IP.
 */
export function normalizeIp(ip: string | undefined): string | undefined {
	if (ip === undefined) return undefined;
	const parsed = parseIp(ip);
	return parsed === undefined ? undefined : formatIp(parsed);
}

export function normalizeSubject(subject: SubjectRef): SubjectRef {
	const domain = normalizeDomain(subject.domain);
	const ip = normalizeIp(subject.ip);
	const out: SubjectRef = {};
	if (domain !== undefined) out.domain = domain;
	if (ip !== undefined) out.ip = ip;
	return out;
}

/** True when two subject references name the same party. */
export function sameParty(a: SubjectRef, b: SubjectRef): boolean {
	const aDomain = normalizeDomain(a.domain);
	const bDomain = normalizeDomain(b.domain);
	if (aDomain !== undefined || bDomain !== undefined) return aDomain === bDomain;
	const aIp = normalizeIp(a.ip);
	const bIp = normalizeIp(b.ip);
	return aIp !== undefined && aIp === bIp;
}

/**
 * One attestation as the policy sees it: a single fact, with every log
 * coordinate it was found at.
 *
 * `logId`/`index` are the entry's identity — the lowest coordinate it holds, so
 * that identity does not depend on which log answered first — while `loggedAt`
 * is the earliest inclusion time any of `refs` proves. Explanations cite the
 * whole union, which is what makes a cross-submitted attestation auditable in
 * every log it reached.
 */
export interface MergedEntry extends SequencedAttestation {
	/** Every coordinate this attestation holds, in log order; never empty. */
	refs: LogEntryRef[];
}

/**
 * Total order on log entries: `(logId, index)`, with the canonical form of the
 * attestation as the final tiebreak so two entries sharing a coordinate still
 * sort deterministically before they are deduplicated.
 */
function compareEntries(a: SequencedAttestation, b: SequencedAttestation): number {
	if (a.logId !== b.logId) return a.logId < b.logId ? -1 : 1;
	if (a.index !== b.index) return a.index - b.index;
	const left = canonicalize(a.attestation);
	const right = canonicalize(b.attestation);
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/**
 * True when an entry is visible at `asOf`: the log has sequenced it, and any
 * window it carries has closed.
 *
 * Spec §2.4 requires both bounds, and both are enforced here rather than left
 * to the caller. Omitting the window bound is exploitable, not merely lax:
 * decay reads `window.to` where a record has one, so evidence logged six months
 * ago carrying a `window.to` a decade out would arrive undecayed and outweigh
 * honest evidence of the same age.
 *
 * The rules this layer cannot check stay with the aggregator: the §2.4
 * clock-skew bound needs a deployment constant, and signature and DNS
 * verification need the network. What is left is a pure function of the entry
 * and `asOf`, so the policy owns it and no caller can forget it.
 *
 * An unparseable `loggedAt` or `window.to` fails the test, as everywhere else
 * in this module: a timestamp the policy cannot order is not one it can score
 * against.
 */
function isVisibleAt(entry: SequencedAttestation, asOf: string): boolean {
	if (!isAtOrBefore(entry.loggedAt, asOf)) return false;
	const closesAt = entry.attestation.window?.to;
	// Windows are half-open `[from, to)`, so one ending exactly at `asOf` has
	// closed and is admissible.
	return closesAt === undefined || isAtOrBefore(closesAt, asOf);
}

/**
 * The deterministic merge of spec §6.2: sort by `(logId, index)`, drop entries
 * not yet visible at `asOf` ({@link isVisibleAt}), drop repeated coordinates,
 * and fold cross-submitted copies into one entry.
 *
 * Two distinct rules, in that order:
 *  - One `(logId, index)` is one leaf. A second entry claiming a coordinate the
 *    log already used is evidence of equivocation (spec §5.6), not a second
 *    fact, and the later claim is dropped.
 *  - Copies of one signed attestation on several logs are one attestation with
 *    several coordinates (spec §5.5). They are folded on the canonical bytes of
 *    the signed record, keeping the earliest provable `loggedAt` and the union
 *    of the coordinates. Without this fold, cross-submission — a MUST from
 *    Phase 2 — would multiply every count, volume, trap and history signal by
 *    the number of logs a submitter reaches.
 *
 * The result is ordered by each entry's identity coordinate, which is unique
 * after the first rule, so the sequence is a total order that no permutation of
 * the input can disturb.
 */
export function orderEntries(
	entries: readonly SequencedAttestation[],
	asOf: string
): MergedEntry[] {
	const visible = entries.filter((entry) => isVisibleAt(entry, asOf));
	const sorted = [...visible].sort(compareEntries);
	const coordinates = new Set<string>();
	// Keyed on the canonical signed record; insertion order is ascending
	// identity coordinate, because `sorted` is and identities are first-seen.
	const merged = new Map<string, MergedEntry>();
	for (const entry of sorted) {
		const key = entryKey(entry);
		if (coordinates.has(key)) continue;
		coordinates.add(key);
		const ref: LogEntryRef = { logId: entry.logId, index: entry.index };
		const canonical = canonicalize(entry.attestation);
		const seen = merged.get(canonical);
		if (seen === undefined) {
			merged.set(canonical, { ...entry, refs: [ref] });
			continue;
		}
		seen.refs.push(ref);
		// The earliest inclusion any log proves. A log that back-dates an entry
		// only ever ages evidence it also holds, and ageing evidence weakens it.
		if (isAtOrBefore(entry.loggedAt, seen.loggedAt)) seen.loggedAt = entry.loggedAt;
	}
	return [...merged.values()];
}

/**
 * Ranges a domain has declared as its own in a posture attestation it authored
 * (plan D2). A bare address widens to its default aggregation prefix — /32 for
 * IPv4, /64 for IPv6 — because that is the granularity bare-IP evidence is
 * grouped at in the first place; a CIDR entry is taken at its stated width.
 * Evidence on an IP the domain has not claimed does not reach the domain.
 */
function declaredRangesFor(
	ordered: readonly MergedEntry[],
	excluded: ReadonlySet<string>,
	domain: string
): ParsedCidr[] {
	const ranges: ParsedCidr[] = [];
	for (const entry of ordered) {
		if (entry.attestation.kind !== 'posture') continue;
		if (excluded.has(entryKey(entry))) continue;
		if (normalizeDomain(entry.attestation.subject.domain) !== domain) continue;
		if (observerKey(entry.attestation.observer) !== domain) continue;
		for (const declared of bodyOf<PostureBody>(entry.attestation).declaredIps ?? []) {
			const range = parseCidr(declared);
			if (range === undefined) continue;
			if (declared.includes('/')) ranges.push(range);
			else {
				const widened = parseCidr(defaultPrefixKey(range));
				if (widened !== undefined) ranges.push(widened);
			}
		}
	}
	return ranges;
}

/** True when bare-IP evidence at `ip` belongs to the bare-IP subject `subjectIp`. */
function inSubjectPrefix(ip: string, subjectIp: string): boolean {
	const evidence = parseIp(ip);
	const subject = parseIp(subjectIp);
	if (evidence === undefined || subject === undefined) return false;
	const range = parseCidr(defaultPrefixKey(subject));
	return range !== undefined && inRange(evidence, range);
}

/**
 * Entries whose subject is the scored subject (plan D2/D3).
 *
 * Domain is primary and is the exact `d=` identity: `(ip, domain)` pair
 * evidence flows into the domain, and bare-IP evidence joins it only for ranges
 * the domain declared. A bare-IP subject sees only bare-IP evidence, aggregated
 * across its /32 (IPv4) or /64 (IPv6) — a shared IP's other tenants stay on
 * their own `(ip, domain)` pairs.
 */
export function selectSubjectEntries(
	ordered: readonly MergedEntry[],
	excluded: ReadonlySet<string>,
	subject: SubjectRef
): MergedEntry[] {
	const target = normalizeSubject(subject);
	const domain = target.domain;
	const ip = target.ip;
	const declared = domain === undefined ? [] : declaredRangesFor(ordered, excluded, domain);

	return ordered.filter((entry) => {
		if (excluded.has(entryKey(entry))) return false;
		const entryDomain = normalizeDomain(entry.attestation.subject.domain);
		const entryIp = normalizeIp(entry.attestation.subject.ip);
		if (domain !== undefined) {
			if (entryDomain !== undefined) return entryDomain === domain;
			if (entryIp === undefined) return false;
			const parsed = parseIp(entryIp);
			return parsed !== undefined && declared.some((range) => inRange(parsed, range));
		}
		if (ip !== undefined)
			return entryDomain === undefined && entryIp !== undefined && inSubjectPrefix(entryIp, ip);
		return false;
	});
}
