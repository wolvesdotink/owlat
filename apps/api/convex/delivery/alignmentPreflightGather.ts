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
 *
 * Outbound work is TIME-BOUNDED, like the shipped `MTA_STS_FETCH_TIMEOUT_MS`
 * gather: a slow-drip nameserver must not be able to burn the action budget for
 * every other domain in the sweep.
 */

import { v } from 'convex/values';
import { Resolver } from 'node:dns/promises';
import {
	ALIGNMENT_SWEEP_MAX_PAGES,
	ALIGNMENT_SWEEP_PAGE_SIZE,
	dkimRecordName,
	evaluateAlignmentPreflight,
	normalizeDomain,
	type AlignmentArm,
	type AlignmentDnsFacts,
	type DnsTxtObservation,
} from '@owlat/shared/deliverabilityAlignment';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { logWarn } from '../lib/runtimeLog';
// Type-only: a `'use node'` module must not pull a query/mutation module into
// its bundle, and a type import is erased at build time.
import type { AlignmentTarget } from './alignmentPreflight';

/** Per-lookup deadline, and how many times the resolver retries within it. */
const ALIGNMENT_DNS_TIMEOUT_MS = 5_000;
const ALIGNMENT_DNS_TRIES = 2;

/** Injected DNS primitive so the failure mapping is testable without a network. */
export interface AlignmentDnsDeps {
	/** Resolve a TXT record to its raw chunk arrays (per `node:dns` `resolveTxt`). */
	resolveTxt(name: string): Promise<string[][]>;
}

const boundedResolver = new Resolver({
	timeout: ALIGNMENT_DNS_TIMEOUT_MS,
	tries: ALIGNMENT_DNS_TRIES,
});

const defaultDeps: AlignmentDnsDeps = {
	resolveTxt: (name) => boundedResolver.resolveTxt(name),
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

/** Sentinel for "the deadline fired first" — distinct from any resolver value. */
const DEADLINE = Symbol('alignment-dns-deadline');

async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T | typeof DEADLINE> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<typeof DEADLINE>((resolve) => {
				timer = setTimeout(() => resolve(DEADLINE), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * One TXT observation, with the absent/unknown distinction preserved and a hard
 * deadline: a lookup that never settles is `unknown` (a hold), never a pass and
 * never a fail.
 */
export async function observeTxt(
	name: string,
	deps: AlignmentDnsDeps = defaultDeps,
	timeoutMs: number = ALIGNMENT_DNS_TIMEOUT_MS
): Promise<DnsTxtObservation> {
	try {
		const chunks = await withDeadline(deps.resolveTxt(name), timeoutMs);
		if (chunks === DEADLINE) return { state: 'unknown', failure: 'timeout' };
		// RFC 1035 multi-string records are joined without a separator.
		const records = chunks.map((parts) => parts.join(''));
		return records.length === 0 ? { state: 'absent' } : { state: 'found', records };
	} catch (error) {
		const code = errorCodeOf(error);
		if (ABSENT_CODES.has(code)) return { state: 'absent' };
		return { state: 'unknown', failure: UNKNOWN_CODES[code] ?? 'error' };
	}
}

/** Every DKIM TXT name one arm publishes at, spelled by the shared helper. */
function dkimRecordNames(arm: AlignmentArm): string[] {
	return arm.dkimSelectors.map((selector) => dkimRecordName(selector, arm.dkimDomain));
}

/** Gather every DNS fact one target needs. Bounded: 2 + one lookup per selector. */
export async function gatherAlignmentDns(
	target: AlignmentTarget,
	deps: AlignmentDnsDeps = defaultDeps
): Promise<AlignmentDnsFacts> {
	const fromDomain = normalizeDomain(target.ownArm.fromDomain);
	const dkimNames = new Set<string>([
		...dkimRecordNames(target.ownArm),
		...(target.reference.kind === 'arm' ? dkimRecordNames(target.reference.arm) : []),
	]);
	const [fromDomainTxt, dmarcTxt, dkimEntries] = await Promise.all([
		observeTxt(fromDomain, deps),
		observeTxt(`_dmarc.${fromDomain}`, deps),
		Promise.all([...dkimNames].map(async (name) => [name, await observeTxt(name, deps)] as const)),
	]);
	return { fromDomainTxt, dmarcTxt, dkimTxt: Object.fromEntries(dkimEntries) };
}

/**
 * Alignment re-verification sweep, run hourly so the shorter UNKNOWN retry
 * cadence (`ALIGNMENT_UNKNOWN_RETRY_MS`) is actually honoured — a domain whose
 * lookups did not resolve is re-checked in about an hour, not in about a day,
 * while a resolved domain is simply not due and costs one indexed read.
 *
 * Bounded per run and CONTINUED rather than truncated: each run walks at most
 * `ALIGNMENT_SWEEP_MAX_PAGES` pages and, if more verified domains remain, hands
 * the cursor to a scheduled continuation (the `checklistSweep` idiom). One
 * target's failure never abandons the rest.
 */
export const runAlignmentPreflightSweep = internalAction({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	handler: async (ctx, args): Promise<{ checked: number; done: boolean }> => {
		const now = Date.now();
		let cursor = args.cursor ?? null;
		let checked = 0;
		let done = false;
		for (let page = 0; page < ALIGNMENT_SWEEP_MAX_PAGES; page += 1) {
			const slice = await ctx.runQuery(
				internal.delivery.alignmentPreflight.listDueAlignmentTargets,
				{ now, paginationOpts: { cursor, numItems: ALIGNMENT_SWEEP_PAGE_SIZE } }
			);
			for (const target of slice.targets) {
				try {
					const dnsFacts = await gatherAlignmentDns(target);
					const result = evaluateAlignmentPreflight({
						ownArm: target.ownArm,
						reference: target.reference,
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
					checked += 1;
				} catch (error) {
					// One unreachable nameserver or one write conflict must not abandon
					// every remaining due domain until the next run.
					logWarn(
						`[alignment] pre-flight failed for ${target.domain}: ${error instanceof Error ? error.message : String(error)}`
					);
				}
			}
			cursor = slice.continueCursor;
			if (slice.isDone) {
				done = true;
				break;
			}
		}
		if (!done) {
			await ctx.scheduler.runAfter(
				500,
				internal.delivery.alignmentPreflightGather.runAlignmentPreflightSweep,
				{ cursor }
			);
		}
		return { checked, done };
	},
});
