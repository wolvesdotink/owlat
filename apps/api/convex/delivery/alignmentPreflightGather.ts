'use node';

/**
 * Dual-transport alignment pre-flight — live-DNS gather half (P3-5).
 *
 * Separate from `alignmentPreflight.ts` because it needs `node:dns` and must be
 * a `'use node'` module, where Convex forbids queries and mutations. The DNS
 * primitive is injected (mirroring `domains/mtaStsVerify.ts`) so the failure
 * mapping is unit-testable without a network.
 *
 * FAILURE SEMANTICS ARE THE POINT: an authoritative "no such record"
 * (NXDOMAIN / empty answer) is `absent` and FAILS the check; a timeout,
 * SERVFAIL or REFUSED is `unknown` and HOLDS the cell. Unlike the rest of this
 * backend's DNS reads, this one must NOT fail soft to "not found" — laundering
 * an unresolved lookup into "no record" would report a misconfiguration that
 * may not exist, and laundering it into "aligned" would let a genuinely
 * misconfigured cell ramp.
 */

import { v } from 'convex/values';
import dns from 'node:dns/promises';
import {
	evaluateAlignmentPreflight,
	type AlignmentArm,
	type AlignmentDnsFacts,
	type DnsTxtObservation,
} from '@owlat/shared/deliverabilityAlignment';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
// Type-only: a `'use node'` module must not pull a query/mutation module into
// its bundle, and a type import is erased at build time.
import type { AlignmentTarget } from './alignmentPreflight';

/** Upper bound on domains re-checked per sweep (mirrors ALIGNMENT_SWEEP_LIMIT). */
const SWEEP_LIMIT = 25;

/** Injected DNS primitive so the failure mapping is testable without a network. */
export interface AlignmentDnsDeps {
	/** Resolve a TXT record to its raw chunk arrays (per `node:dns` `resolveTxt`). */
	resolveTxt(name: string): Promise<string[][]>;
}

const defaultDeps: AlignmentDnsDeps = {
	resolveTxt: (name) => dns.resolveTxt(name),
};

/** node:dns error codes that mean "authoritatively, there is no such record". */
const ABSENT_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

/** Everything else is UNKNOWN; these three get a specific label. */
const UNKNOWN_CODES: Readonly<Record<string, DnsLookupFailureCode>> = {
	ETIMEOUT: 'timeout',
	ETIMEDOUT: 'timeout',
	ESERVFAIL: 'servfail',
	EREFUSED: 'refused',
	ECONNREFUSED: 'refused',
};

type DnsLookupFailureCode = Extract<DnsTxtObservation, { state: 'unknown' }>['failure'];

function errorCodeOf(error: unknown): string {
	if (typeof error === 'object' && error !== null && 'code' in error) {
		const code = (error as { code: unknown }).code;
		if (typeof code === 'string') return code.toUpperCase();
	}
	return '';
}

/** One TXT observation, with the absent/unknown distinction preserved. */
export async function observeTxt(
	name: string,
	deps: AlignmentDnsDeps = defaultDeps
): Promise<DnsTxtObservation> {
	try {
		const chunks = await deps.resolveTxt(name);
		// RFC 1035 multi-string records are joined without a separator.
		const records = chunks.map((parts) => parts.join(''));
		return records.length === 0 ? { state: 'absent' } : { state: 'found', records };
	} catch (error) {
		const code = errorCodeOf(error);
		if (ABSENT_CODES.has(code)) return { state: 'absent' };
		return { state: 'unknown', failure: UNKNOWN_CODES[code] ?? 'error' };
	}
}

function dkimRecordNames(arm: AlignmentArm): string[] {
	const dkimDomain = arm.dkimDomain.trim().toLowerCase().replace(/\.$/, '');
	return arm.dkimSelectors.map(
		(selector) => `${selector.trim().toLowerCase()}._domainkey.${dkimDomain}`
	);
}

/** Gather every DNS fact one target needs. Bounded: 2 + one lookup per selector. */
export async function gatherAlignmentDns(
	target: AlignmentTarget,
	deps: AlignmentDnsDeps = defaultDeps
): Promise<AlignmentDnsFacts> {
	const fromDomain = target.ownArm.fromDomain.trim().toLowerCase().replace(/\.$/, '');
	const names = new Set<string>([
		...dkimRecordNames(target.ownArm),
		...(target.referenceArm ? dkimRecordNames(target.referenceArm) : []),
	]);
	const dkimTxt: Record<string, DnsTxtObservation> = {};
	const [fromDomainTxt, dmarcTxt, ...dkimObservations] = await Promise.all([
		observeTxt(fromDomain, deps),
		observeTxt(`_dmarc.${fromDomain}`, deps),
		...[...names].map((name) => observeTxt(name, deps)),
	]);
	[...names].forEach((name, index) => {
		const observation = dkimObservations[index];
		if (observation) dkimTxt[name] = observation;
	});
	return { fromDomainTxt, dmarcTxt, dkimTxt };
}

/**
 * Daily sweep: re-verify every due sending domain and persist its verdict.
 * Bounded per run; a domain whose lookups did not resolve is retried on the
 * shorter unknown cadence rather than waiting a full day.
 */
export const runAlignmentPreflightSweep = internalAction({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args): Promise<{ checked: number }> => {
		const now = Date.now();
		const targets: AlignmentTarget[] = await ctx.runQuery(
			internal.delivery.alignmentPreflight.listDueAlignmentTargets,
			{ now, limit: args.limit ?? SWEEP_LIMIT }
		);
		for (const target of targets) {
			const dnsFacts = await gatherAlignmentDns(target);
			const result = evaluateAlignmentPreflight({
				ownArm: target.ownArm,
				referenceArm: target.referenceArm,
				dns: dnsFacts,
				checkedAt: now,
			});
			await ctx.runMutation(internal.delivery.alignmentPreflight.recordAlignmentResult, {
				domain: target.domain,
				verdict: result.verdict,
				checks: result.checks,
				degradedMeasurement: result.degradedMeasurement,
				...(result.degradedMeasurementReason === null
					? {}
					: { degradedMeasurementReason: result.degradedMeasurementReason }),
				checkedAt: result.checkedAt,
				nextCheckDueAt: result.nextCheckDueAt,
			});
		}
		return { checked: targets.length };
	},
});
