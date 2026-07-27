/**
 * The dual-transport alignment gate for the delivery readiness panel (P3-5).
 *
 * Split out of `deliveryReadiness.ts` (which sits at the repo's 500-LOC cap):
 * that file owns the go-live verdict — can this instance send at all — while this
 * one owns a strictly ADVISORY gate about the gradual own-server/relay
 * switchover. Keeping them apart is also what makes the D2 rule easy to see: this
 * module's only job is to decide when to say NOTHING.
 *
 * Pure primitives in, plain data out — no Convex client, no DOM.
 */

import type { ReadinessGate } from '~/utils/readinessGate';

/**
 * One sending domain's dual-transport alignment verdict, as
 * `delivery.alignmentPreflight.getAlignmentReadiness` returns it. Structural on
 * purpose so this stays free of the Convex client.
 */
export interface ReadinessDualArmRow {
	domain: string;
	verdict: 'aligned' | 'single_arm' | 'blocked' | 'unknown';
	checks: readonly {
		id: 'from_domain' | 'spf' | 'dkim' | 'dmarc';
		status: 'pass' | 'fail' | 'unknown';
		detail: string;
		remedy: string;
	}[];
	isMeasurementDegraded: boolean;
	measurementDegradedReason: string | null;
}

/**
 * What the dual-arm gate should say.
 *
 * "Say nothing" is `undefined` — the ABSENCE of a summary — and it is encoded
 * exactly once, in `summarizeDualArmAlignment`'s return type. A
 * `'not_applicable'` member here would be a second encoding of the same fact that
 * every consumer would then have to remember to filter out.
 */
export interface ReadinessDualArmSummary {
	state: 'aligned' | 'unknown' | 'blocked';
	/** The domains the state is about, in the order returned. */
	domains: string[];
	/** The first failing check's remedy, or `null` when nothing is failing. */
	remedy: string | null;
	/** Return-Path could not be aligned — measurement is coarser, nothing is broken. */
	degradedReason: string | null;
}

const DOMAINS_HREF = '/dashboard/delivery/domains';

/**
 * Fold the alignment pre-flight rows into one summary, or `undefined` when there
 * is NOTHING TO SAY — in which case no gate is rendered at all.
 *
 * `single_arm` rows are nothing to say, exactly like no rows at all: a deployment
 * with no reference transport must not be told about a check that cannot apply to
 * it (D2). A `blocked` verdict outranks an `unknown` one, and an `unknown`
 * outranks `aligned`, because that is the order an operator should read them in.
 */
export function summarizeDualArmAlignment(
	rows: readonly ReadinessDualArmRow[] | null | undefined
): ReadinessDualArmSummary | undefined {
	const relevant = (rows ?? []).filter((row) => row.verdict !== 'single_arm');
	if (relevant.length === 0) return undefined;
	const degradedReason =
		relevant.find((row) => row.isMeasurementDegraded)?.measurementDegradedReason ?? null;
	const blocked = relevant.filter((row) => row.verdict === 'blocked');
	if (blocked.length > 0) {
		const remedy =
			blocked
				.flatMap((row) => row.checks)
				.find((check) => check.status === 'fail' && check.remedy !== '')?.remedy ?? null;
		return { state: 'blocked', domains: blocked.map((row) => row.domain), remedy, degradedReason };
	}
	const unresolved = relevant.filter((row) => row.verdict === 'unknown');
	if (unresolved.length > 0) {
		return {
			state: 'unknown',
			domains: unresolved.map((row) => row.domain),
			remedy: null,
			degradedReason,
		};
	}
	return {
		state: 'aligned',
		domains: relevant.map((row) => row.domain),
		remedy: null,
		degradedReason,
	};
}

/**
 * The gate itself — rendered only when a reference transport is actually in play,
 * so a deployment running on the own MTA alone never sees it (D2).
 *
 * It never blocks sending: what it gates is the RAMP. A `blocked` verdict means
 * the two arms are not comparable yet, so the controller holds the cell at 0%
 * own-MTA share; the instance keeps sending exactly as before. `unknown` is DNS
 * that has not answered — pending, with nothing for the operator to do.
 */
export function dualArmAlignmentGate(summary: ReadinessDualArmSummary): ReadinessGate {
	const named = summary.domains.length > 0 ? ` (${summary.domains.join(', ')})` : '';
	const title = 'Dual-transport alignment';
	if (summary.state === 'blocked') {
		return {
			key: 'dual-arm-alignment',
			title,
			detail:
				`The own server and your relay don't look identical to mailboxes yet${named}, so the gradual switchover is on hold. ${summary.remedy ?? ''}`.trim(),
			status: 'attention',
			tone: 'warning',
			actionHref: DOMAINS_HREF,
			actionLabel: 'Review records',
		};
	}
	if (summary.state === 'unknown') {
		return {
			key: 'dual-arm-alignment',
			title,
			detail: `We couldn't finish reading DNS for${named || ' your sending domains'} yet, so the switchover holds where it is. This re-checks itself — nothing for you to do.`,
			status: 'pending',
			tone: 'neutral',
			actionHref: null,
			actionLabel: null,
		};
	}
	const degraded = summary.degradedReason === null ? '' : ` ${summary.degradedReason}`;
	return {
		key: 'dual-arm-alignment',
		title,
		detail: `Your own server and your relay look identical to mailboxes${named}, so the gradual switchover can measure them fairly.${degraded}`,
		status: 'ready',
		tone: 'success',
		actionHref: null,
		actionLabel: null,
	};
}
