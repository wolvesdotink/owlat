/**
 * The bounded signals of `ostr-policy-v1`: posture, vouches and the observer
 * diversity multiplier (plan §6.2, §6.4).
 *
 * All three are deliberately capped. Posture is cheap to publish, vouches are
 * a cold-start ramp with someone else's standing at stake, and diversity only
 * ever multiplies evidence that already exists — none of them can carry a
 * subject on its own.
 */

import type { LogEntryRef, PostureBody } from '../types.js';
import { daysBetween } from './math.js';
import { POLICY_V1 } from './policy.js';
import type { SubjectFacts } from './facts.js';
import { refKey, type ObserverGrouper } from './select.js';
import { contributionOf, type ObserverWeigher, type SignalGroup } from './signals.js';

/** Posture components, in a fixed order so summaries are stable. */
function postureFeatures(body: PostureBody, asOf: string): { label: string; points: number }[] {
	const posture = POLICY_V1.posture;
	const features: { label: string; points: number }[] = [];
	if (body.dmarcPolicy === 'reject') {
		features.push({ label: 'DMARC p=reject', points: posture.dmarcRejectPoints });
	} else if (body.dmarcPolicy === 'quarantine') {
		features.push({ label: 'DMARC p=quarantine', points: posture.dmarcQuarantinePoints });
	}
	if (body.dmarcAlignment === 'strict') {
		features.push({ label: 'strict alignment', points: posture.strictAlignmentPoints });
	}
	if (body.dnssec === true) features.push({ label: 'DNSSEC', points: posture.dnssecPoints });
	if (body.mtaSts === true) features.push({ label: 'MTA-STS', points: posture.mtaStsPoints });
	if (body.tlsRpt === true) features.push({ label: 'TLS-RPT', points: posture.tlsRptPoints });
	if ((body.declaredIps ?? []).length > 0) {
		features.push({ label: 'declared IPs', points: posture.declaredIpsPoints });
	}
	if (
		body.registeredBefore !== undefined &&
		daysBetween(body.registeredBefore, asOf) >= posture.registeredBeforeMinAgeDays
	) {
		features.push({ label: 'aged registration', points: posture.registeredBeforePoints });
	}
	return features;
}

/**
 * Published posture, capped at `POLICY_V1.posture.maxLiftPoints`.
 *
 * Only the subject's own posture reaches this function (see `facts.ts`), and it
 * is taken at face value rather than scaled by the subject's own standing —
 * that would be circular, and every posture claim is independently checkable in
 * DNS. Third-party posture is not evidence about anyone's configuration: as a
 * scored signal it would be both free points for a subject a stranger likes and
 * a griefing primitive against one it does not.
 */
export function postureSignal(facts: SubjectFacts, asOf: string): SignalGroup | undefined {
	const posture = facts.posture;
	if (posture === undefined) return undefined;
	const features = postureFeatures(posture.body, asOf);
	if (features.length === 0) return undefined;
	let points = 0;
	for (const feature of features) points += feature.points;
	const contribution = Math.min(points, POLICY_V1.posture.maxLiftPoints);
	return {
		signal: 'posture',
		summary: `Published posture: ${features.map((feature) => feature.label).join(', ')}.`,
		evidence: [...posture.refs],
		parts: new Map([[posture.observer, contribution]]),
		observed: false,
	};
}

/**
 * Outstanding vouches per voucher, across every subject in the entry set.
 * Supplied by the caller because it is a property of the whole log, not of one
 * subject's evidence.
 */
export type VouchLoad = (voucher: string) => number;

/**
 * Active vouches (plan §6.4). Each voucher's stake is scaled by its own
 * standing, diluted by everything else it is currently underwriting, and the
 * sum is capped — so no amount of vouching substitutes for observed behavior,
 * and "a hosting provider cannot underwrite a thousand tenants with reputation
 * it only has once".
 *
 * DEFERRED §6.4 ITEM: the voucher-side consequence — "if the newcomer spams
 * inside the vouch window, the voucher's standing takes the documented hit" —
 * is not implemented. It needs an attribution rule for which of a voucher's
 * subjects' negatives fall inside which vouch window, and that rule belongs in
 * a policy version that can be diffed on its own.
 */
export function vouchSignal(
	facts: SubjectFacts,
	weightFor: ObserverWeigher,
	loadOf: VouchLoad
): SignalGroup | undefined {
	if (facts.vouches.length === 0) return undefined;
	const { pointsPerVouch, maxStakePoints } = POLICY_V1.vouch;
	const raw = new Map<string, number>();
	const evidence: LogEntryRef[] = [];
	let total = 0;
	for (const vouch of facts.vouches) {
		// The voucher's whole at-risk stake is bounded, so each additional
		// outstanding vouch is worth proportionally less.
		const outstanding = Math.max(loadOf(vouch.observer), 1);
		const stake = Math.min(pointsPerVouch, maxStakePoints / outstanding);
		const points = stake * weightFor(vouch.observer);
		raw.set(vouch.observer, (raw.get(vouch.observer) ?? 0) + points);
		evidence.push(...vouch.refs);
		total += points;
	}
	const scale = total > POLICY_V1.vouch.capPoints ? POLICY_V1.vouch.capPoints / total : 1;
	const parts = new Map<string, number>();
	for (const [observer, points] of raw) parts.set(observer, points * scale);
	return {
		signal: 'vouches',
		summary: `${facts.vouches.length === 1 ? '1 active vouch' : `${facts.vouches.length} active vouches`} from ${
			raw.size === 1 ? '1 voucher' : `${raw.size} vouchers`
		}.`,
		evidence,
		parts,
		observed: false,
	};
}

/**
 * Observer diversity (plan §6.2): a multiplier on *observed* positive
 * evidence. The uplift is attributed back to the same observers in proportion
 * to what each contributed, so it stays inside the §6.3 per-observer cap.
 *
 * Witnesses are counted by control group, not by name: `mx2.x`, `mx3.x` and
 * `mx4.x` are one witness, so corroboration cannot be minted from a wildcard
 * DNS record (§7.3 "ring members … get diversity-collapsed to ~one observer's
 * cap"). What the v1 grouping does *not* judge is shared infrastructure or ASN
 * — see `defaultObserverGroup` in `select.ts` for what is still owed and how a
 * caller supplies it.
 *
 * Returns `undefined` below `POLICY_V1.diversity.minObservers` — the same
 * counts from two witnesses earn nothing extra.
 */
export function diversitySignal(
	groups: readonly SignalGroup[],
	groupOf: ObserverGrouper
): SignalGroup | undefined {
	const positives = new Map<string, number>();
	const controlGroups = new Set<string>();
	const evidence: LogEntryRef[] = [];
	const seen = new Set<string>();
	let base = 0;
	for (const group of groups) {
		if (!group.observed || contributionOf(group) <= 0) continue;
		for (const [observer, part] of group.parts) {
			if (!(part > 0)) continue;
			positives.set(observer, (positives.get(observer) ?? 0) + part);
			controlGroups.add(groupOf(observer));
			base += part;
		}
		for (const ref of group.evidence) {
			const key = refKey(ref);
			if (seen.has(key)) continue;
			seen.add(key);
			evidence.push(ref);
		}
	}
	const observers = controlGroups.size;
	if (observers < POLICY_V1.diversity.minObservers || !(base > 0)) return undefined;
	const multiplier = Math.min(
		POLICY_V1.diversity.maxMultiplier,
		1 + (observers - 1) * POLICY_V1.diversity.stepPerObserver
	);
	const uplift = base * (multiplier - 1);
	if (!(uplift > 0)) return undefined;
	const parts = new Map<string, number>();
	for (const [observer, part] of positives) parts.set(observer, uplift * (part / base));
	return {
		signal: 'observer-diversity',
		summary: `Positive evidence corroborated by ${observers} distinct observers.`,
		evidence,
		parts,
		observed: true,
	};
}
