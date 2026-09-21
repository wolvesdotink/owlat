/**
 * The signal functions of `ostr-policy-v1` (plan §6.2). Each turns the
 * subject's aggregated evidence into one attributed group: a signed
 * contribution split across the observers that supplied the evidence, plus a
 * deterministic summary sentence.
 *
 * Attribution is what makes the §6.3 per-observer cap possible: a group's
 * contribution is always exactly the sum of its parts, so scaling one
 * observer's parts down scales the group down with it. The corollary is a rule
 * every signal here follows — an observer's part must be justified by that
 * observer's own numbers, or the party that sets a signal's magnitude is not
 * the party the cap charges for it.
 *
 * Observer keys are already normalized by `extractFacts`; nothing in this file
 * compares a raw `attestation.observer` string.
 */

import type { LogEntryRef } from '../types.js';
import { clamp, logSaturation, roundTo } from './math.js';
import { POLICY_V1 } from './policy.js';
import type { SubjectFacts } from './facts.js';

/** An explanation group before rounding, with its per-observer attribution. */
export interface SignalGroup {
	signal: string;
	summary: string;
	evidence: LogEntryRef[];
	/** Signed points per observer; the group's contribution is their sum. */
	parts: Map<string, number>;
	/**
	 * True for evidence a third party observed, as opposed to self-asserted
	 * posture or a vouch. Only observed positive evidence earns the diversity
	 * multiplier and lets a subject rise above `establishing`.
	 */
	observed: boolean;
}

export type ObserverWeigher = (observer: string) => number;

export function contributionOf(group: SignalGroup): number {
	let total = 0;
	for (const part of group.parts.values()) total += part;
	return total;
}

/**
 * Split `magnitude` across observers in proportion to `mass × standing`, and
 * report the volume-weighted mean standing (`blend`) that scaled it.
 */
function attribute(
	masses: ReadonlyMap<string, number>,
	weightFor: ObserverWeigher
): { blend: number; shares: Map<string, number> } {
	let massTotal = 0;
	let weightedTotal = 0;
	const weighted = new Map<string, number>();
	for (const [observer, mass] of masses) {
		if (!(mass > 0)) continue;
		const value = mass * weightFor(observer);
		massTotal += mass;
		weightedTotal += value;
		weighted.set(observer, value);
	}
	const shares = new Map<string, number>();
	if (!(weightedTotal > 0) || !(massTotal > 0)) return { blend: 0, shares };
	for (const [observer, value] of weighted) shares.set(observer, value / weightedTotal);
	return { blend: weightedTotal / massTotal, shares };
}

function partsFrom(shares: ReadonlyMap<string, number>, contribution: number): Map<string, number> {
	const parts = new Map<string, number>();
	for (const [observer, share] of shares) parts.set(observer, contribution * share);
	return parts;
}

function percent(value: number): string {
	return `${roundTo(value * 100, POLICY_V1.contributionDecimals)}%`;
}

function plural(count: number, singular: string, pluralForm: string): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Volume-weighted DMARC/DKIM/SPF pass rates, and the 0..1 hygiene factor they yield. */
export interface AuthQuality {
	dmarcRate: number;
	dkimRate: number;
	spfRate: number;
	/** 0 below the policy floor, 1 at a perfect blended pass rate. */
	factor: number;
}

export function authQuality(facts: SubjectFacts): AuthQuality {
	const messages = facts.totalMessages;
	if (messages <= 0) return { dmarcRate: 0, dkimRate: 0, spfRate: 0, factor: 0 };
	const dmarcRate = facts.totalDmarcPass / messages;
	const dkimRate = facts.totalDkimPass / messages;
	const spfRate = facts.totalSpfPass / messages;
	const { dmarcShare, dkimShare, spfShare, floorPassRate } = POLICY_V1.auth;
	const blended = dmarcRate * dmarcShare + dkimRate * dkimShare + spfRate * spfShare;
	const factor = clamp((blended - floorPassRate) / (1 - floorPassRate), 0, 1);
	return { dmarcRate, dkimRate, spfRate, factor };
}

/**
 * Verified reports ÷ attested volume — a rate, never a count (plan §6.2).
 *
 * Two departures from the naive reading, both required by §7.3:
 *  - The rate is per observer, against that observer's own volume for the
 *    windows it reported on. Numerator and denominator therefore describe the
 *    same period and come from the same party, so under-attesting volume
 *    shrinks the attacker's denominator rather than the subject's, and a
 *    five-year history no longer discounts this month's complaints.
 *  - Per-observer contributions are summed, not averaged: an averaged rate
 *    would let one friendly observer attest a mountain of volume with a token
 *    report batch and dilute every real complaint to nothing. The sum is capped
 *    at the signal's weight, and each party is capped again by §6.3.
 *
 * Age enters as a separate factor, since a ratio of two decayed quantities
 * would not decay at all.
 */
export function complaintRateSignal(
	facts: SubjectFacts,
	weightFor: ObserverWeigher
): SignalGroup | undefined {
	if (facts.reports.refs.length === 0) return undefined;
	const { freeRate, saturationRate, minVolume } = POLICY_V1.complaint;
	const raw = new Map<string, number>();
	let reportMass = 0;
	let volumeTotal = 0;
	let magnitude = 0;
	for (const [observer, evidence] of facts.reports.byObserver) {
		const volume = Math.max(evidence.volume, minVolume);
		const rate = evidence.reports / volume;
		const factor = clamp((rate - freeRate) / (saturationRate - freeRate), 0, 1);
		reportMass += evidence.reports;
		volumeTotal += volume;
		const decay = evidence.reports > 0 ? evidence.decayed / evidence.reports : 0;
		const points = POLICY_V1.weights.complaintRate * factor * decay * weightFor(observer);
		if (!(points > 0)) continue;
		raw.set(observer, points);
		magnitude += points;
	}
	if (!(magnitude > 0)) return undefined;
	const scale =
		magnitude > POLICY_V1.weights.complaintRate ? POLICY_V1.weights.complaintRate / magnitude : 1;
	const parts = new Map<string, number>();
	for (const [observer, points] of raw) parts.set(observer, -points * scale);
	return {
		signal: 'complaint-rate',
		summary: `Verified complaint rate of ${percent(reportMass / volumeTotal)} of the reporting observers' own attested volume, from ${plural(
			raw.size,
			'observer',
			'observers'
		)} across ${plural(facts.reports.refs.length, 'report batch', 'report batches')}.`,
		evidence: facts.reports.refs,
		parts,
		observed: true,
	};
}

/**
 * Spam-trap hits. Trap evidence only one witness has seen is capped (§6.3):
 * traps are unverifiable from the outside, so a lone reporter cannot bury a
 * subject with them.
 */
export function trapHitSignal(
	facts: SubjectFacts,
	weightFor: ObserverWeigher
): SignalGroup | undefined {
	if (facts.traps.refs.length === 0) return undefined;
	const factor = logSaturation(facts.traps.total, POLICY_V1.trap.saturationHits);
	const { blend, shares } = attribute(facts.traps.byObserver, weightFor);
	const observers = facts.traps.byObserver.size;
	let contribution = -POLICY_V1.weights.trapHits * factor * blend;
	const capped = observers <= 1 && -contribution > POLICY_V1.trap.singleObserverCapPoints;
	if (capped) contribution = -POLICY_V1.trap.singleObserverCapPoints;
	return {
		signal: 'trap-hits',
		summary:
			`Spam-trap hits reported by ${plural(observers, 'observer', 'observers')} across ` +
			`${plural(facts.traps.refs.length, 'attestation', 'attestations')}.` +
			(capped ? ' Single-observer trap evidence is capped by policy.' : ''),
		evidence: facts.traps.refs,
		parts: partsFrom(shares, contribution),
		observed: true,
	};
}

/** The hygiene floor: authentication pass rates across the attested volume. */
export function authConsistencySignal(
	facts: SubjectFacts,
	quality: AuthQuality,
	weightFor: ObserverWeigher
): SignalGroup | undefined {
	if (facts.trafficRefs.length === 0 || facts.totalMessages <= 0) return undefined;
	const masses = new Map<string, number>();
	for (const [observer, traffic] of facts.traffic) masses.set(observer, traffic.messages);
	const { blend, shares } = attribute(masses, weightFor);
	const contribution = POLICY_V1.weights.authConsistency * quality.factor * blend;
	return {
		signal: 'auth-consistency',
		summary:
			`DMARC ${percent(quality.dmarcRate)}, DKIM ${percent(quality.dkimRate)}, ` +
			`SPF ${percent(quality.spfRate)} pass rates across ` +
			`${plural(facts.traffic.size, 'observer', 'observers')}.`,
		evidence: facts.trafficRefs,
		parts: partsFrom(shares, contribution),
		observed: true,
	};
}

/**
 * The subject's observed history, in days: the volume-weighted mean of the
 * spans the observers witnessed *themselves*, each bounded by what its own log
 * entries prove (see `resolveHistory` in `facts.ts`).
 *
 * A global minimum over everyone's windows would let one one-message summary
 * with an ancient window backdate a subject's whole history — the signal the
 * plan calls the hardest to fake, for one record. Zero when nobody has attested
 * any volume.
 */
export function observedHistoryDays(facts: SubjectFacts): number {
	let spanMass = 0;
	let spanVolume = 0;
	for (const traffic of facts.traffic.values()) {
		spanMass += traffic.messages * traffic.historyDays;
		spanVolume += traffic.messages;
	}
	return spanVolume > 0 ? spanMass / spanVolume : 0;
}

/**
 * History length × volume, both decade-scaled and multiplied, then gated on
 * authentication quality: a domain that cannot authenticate accrues no
 * positive history at all (plan §6.2).
 */
export function historyVolumeSignal(
	facts: SubjectFacts,
	quality: AuthQuality,
	weightFor: ObserverWeigher
): SignalGroup | undefined {
	// A subject whose observers have all just started keeps the group, at zero:
	// the missing span is the evidence gap the sender most needs to see.
	if (facts.trafficRefs.length === 0 || facts.totalMessages <= 0) return undefined;
	const spanDays = observedHistoryDays(facts);
	const spanFactor = logSaturation(spanDays, POLICY_V1.history.saturationDays);
	const volumeFactor = logSaturation(facts.totalMessages, POLICY_V1.history.saturationMessages);
	const masses = new Map<string, number>();
	for (const [observer, traffic] of facts.traffic) masses.set(observer, traffic.messages);
	const { blend, shares } = attribute(masses, weightFor);
	const contribution =
		POLICY_V1.weights.historyVolume * spanFactor * volumeFactor * quality.factor * blend;
	return {
		signal: 'history-volume',
		summary: `${plural(facts.totalMessages, 'attested message', 'attested messages')} over ${plural(
			Math.floor(spanDays),
			'day',
			'days'
		)} of observed history from ${plural(facts.traffic.size, 'observer', 'observers')}.`,
		evidence: facts.trafficRefs,
		parts: partsFrom(shares, contribution),
		observed: true,
	};
}

/**
 * Dictionary-attack and stale-list indicator, from the bucketed bounce rate.
 *
 * Attribution is by each observer's own bounce mass, not by its message mass:
 * the observer that sets the magnitude is the observer that pays for it under
 * the §6.3 cap. Buckets are clamped to the policy's encoding at fold time, so a
 * single one-message summary cannot cancel — or manufacture — the signal.
 */
export function bounceRateSignal(
	facts: SubjectFacts,
	weightFor: ObserverWeigher
): SignalGroup | undefined {
	if (facts.trafficRefs.length === 0 || facts.totalMessages <= 0) return undefined;
	let bounceMass = 0;
	let decayMass = 0;
	const masses = new Map<string, number>();
	for (const [observer, traffic] of facts.traffic) {
		masses.set(observer, traffic.bounceMass);
		bounceMass += traffic.bounceMass;
		decayMass += traffic.decayedMessages;
	}
	const bucket = bounceMass / facts.totalMessages;
	const { freeBucket, saturationBucket } = POLICY_V1.bounce;
	const factor = clamp((bucket - freeBucket) / (saturationBucket - freeBucket), 0, 1);
	const decay = decayMass / facts.totalMessages;
	const { blend, shares } = attribute(masses, weightFor);
	const contribution = -POLICY_V1.weights.bounceRate * factor * decay * blend;
	return {
		signal: 'bounce-rate',
		summary: `Volume-weighted bounce bucket ${roundTo(
			bucket,
			POLICY_V1.contributionDecimals
		)} across ${plural(facts.traffic.size, 'observer', 'observers')}.`,
		evidence: facts.trafficRefs,
		parts: partsFrom(shares, contribution),
		observed: true,
	};
}
