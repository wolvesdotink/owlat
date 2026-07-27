/**
 * [2] DNSBL lookup — one address against one zone, with a bounded retry.
 *
 * This module owns the resolver conversation and nothing else: the sweep, the
 * Redis state and the halt alert live in `dnsbl.ts` / `dnsblAlert.ts`. The one
 * property it exists to guarantee is that UNKNOWN IS NEVER CLEAN — a timeout,
 * SERVFAIL, REFUSED, resolver-policy refusal or rate limit is the absence of
 * evidence, not evidence of health.
 *
 * It is also the single DNSBL lookup path in the MTA: the periodic routing
 * sweep and the pre-flight IP audit both go through `lookupDnsblZone`.
 */

import { resolve4 } from 'dns/promises';
import type { DnsblListId } from '@owlat/shared/dnsbl';
import type { IpAuditZoneId } from '@owlat/shared/ipAudit';
import { reverseIpAddressForDns } from '@owlat/shared/ipAddress';
import { logger } from '../monitoring/logger.js';

const LOOKUP_TIMEOUT_MS = 5000;
/**
 * A transient resolver failure is retried, because concluding `unknown` costs
 * real ramp progress (unknown preserves quarantine and holds the controller).
 * The retry budget is hard-bounded so a dead resolver cannot stall the sweep:
 * at most `LOOKUP_MAX_ATTEMPTS` attempts, and no attempt starts unless it can
 * also FINISH — its own `LOOKUP_TIMEOUT_MS` included — inside the budget.
 */
export const LOOKUP_MAX_ATTEMPTS = 3;
export const LOOKUP_RETRY_BASE_DELAY_MS = 200;
export const LOOKUP_TOTAL_BUDGET_MS = 12_000;

const CLEAN_DNS_ERROR_CODES = new Set(['ENOTFOUND', 'ENODATA']);
const SAFE_DNS_ERROR_CODES = new Set([
	...CLEAN_DNS_ERROR_CODES,
	'ESERVFAIL',
	'ETIMEOUT',
	'ECANCELLED',
	'EREFUSED',
	'EFORMERR',
	'ENOTIMP',
	'EBADQUERY',
	'EBADNAME',
	'EBADFAMILY',
	'EBADRESP',
	'ECONNREFUSED',
	'ECONNRESET',
	'EAI_AGAIN',
]);

/** The three-state answer. `unknown` is the absence of evidence, never health. */
export type DnsblStatus = 'listed' | 'clean' | 'unknown';

function safeDnsErrorCode(error: unknown): string {
	if (typeof error !== 'object' || error === null || !('code' in error)) return 'unknown';
	const code = error.code;
	return typeof code === 'string' && SAFE_DNS_ERROR_CODES.has(code) ? code : 'unknown';
}

/** Build the family-correct DNSBL query name for one canonical address. */
export function dnsblQueryName(ip: string, zone: string): string {
	const reversed = reverseIpAddressForDns(ip);
	if (!reversed) throw new Error(`Cannot build a DNSBL query for invalid IP address ${ip}`);
	return `${reversed}.${zone}`;
}

/**
 * Resolver seam so callers (and tests) can supply their own DNS transport, plus
 * the injected clock + delay that make the bounded retry deterministic.
 */
export interface DnsblLookupDeps {
	/** DNS transport; defaults to the platform `dns/promises` resolver. */
	resolve4?: (hostname: string) => Promise<string[]>;
	/** Per-attempt timeout; defaults to `LOOKUP_TIMEOUT_MS`. */
	timeoutMs?: number;
	/**
	 * Advisory callers (the /24 neighbourhood sample) set this so a resolver
	 * outage logs at debug instead of emitting one warn per probed address. The
	 * warn exists because ROUTING keeps a stale decision on `unknown`; a probe
	 * that gates nothing has no such consequence to announce.
	 */
	quiet?: boolean;
	/** Retry backoff delay; defaults to a real timer. */
	sleep?: (ms: number) => Promise<void>;
	/** Retry budget clock; defaults to `Date.now`. */
	now?: () => number;
}

export const defaultLookupDeps: DnsblLookupDeps = {
	resolve4,
	sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
	now: () => Date.now(),
};

/** A hostile or misconfigured zone can answer with an unbounded RRset. */
const MAX_RETAINED_ANSWERS = 16;
const MAX_ANSWER_LENGTH = 45;

function boundedAnswers(answers: readonly string[]): string[] {
	return answers
		.slice(0, MAX_RETAINED_ANSWERS)
		.map((answer) => String(answer).slice(0, MAX_ANSWER_LENGTH));
}

/**
 * The outcome of a single lookup attempt.
 *
 * `retryable` separates "the resolver failed to answer" (worth another attempt)
 * from "the resolver answered, and the answer is not usable evidence" — an
 * answered 127.255.255.x reserved code is terminal, and re-querying a zone that
 * just told us we are rate limited only aggravates the limiting.
 */
export interface DnsblLookupResult {
	status: DnsblStatus;
	/** Bounded copy of the raw A answers, for callers that decode return codes. */
	answers: string[];
	retryable: boolean;
	/** Redacted resolver reason, for the single conclusion log line. */
	errorCode?: string;
}

/**
 * Look one IP up in one DNSBL zone and return both the verdict and the raw
 * answers. Exactly ONE attempt; `checkDnsbl` layers the bounded retry on top.
 *
 * An `unknown` is announced here for direct callers (the pre-flight IP audit),
 * at debug when `quiet` is set. `checkDnsbl` suppresses those per-attempt lines
 * and logs once at its conclusion instead: a retry loop that logs a
 * final-sounding verdict per attempt triples warn volume per zone per address
 * during a resolver outage, and two of the three lines are not the conclusion.
 */
export async function lookupDnsblZone(
	ip: string,
	listId: DnsblListId | IpAuditZoneId,
	zone: string,
	deps: DnsblLookupDeps = defaultLookupDeps
): Promise<DnsblLookupResult> {
	const lookup = dnsblQueryName(ip, zone);
	const resolver = deps.resolve4 ?? resolve4;
	const timeoutMs = deps.timeoutMs ?? LOOKUP_TIMEOUT_MS;
	// Never log `zone` or the resolver message: keyed providers such as Abusix
	// embed a credential in the queried hostname and resolver errors often echo it.
	const logUnknown = (errorCode: string) => {
		if (deps.quiet) logger.debug({ ip, listId, errorCode }, 'DNSBL check is unknown');
		else logger.warn({ ip, listId, errorCode }, 'DNSBL check is unknown');
	};

	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			resolver(lookup),
			new Promise<never>(
				(_, reject) =>
					(timeout = setTimeout(() => reject(new Error('DNSBL lookup timeout')), timeoutMs))
			),
		]);
		// 127.255.255.x is the reserved return-code block: resolver policy refusal,
		// open-resolver rejection and query-rate limiting. Spamhaus documents it and
		// the other public feeds follow the same convention, so it is read the same
		// way for every zone — it is neither listing nor delisting evidence, and it
		// must preserve a prior quarantine just like SERVFAIL/timeout.
		if (result.some((addr) => addr.startsWith('127.255.255.'))) {
			logUnknown('resolver_policy');
			return {
				status: 'unknown',
				answers: boundedAnswers(result),
				retryable: false,
				errorCode: 'resolver_policy',
			};
		}
		// An answer we cannot interpret is still an answer: terminal, not retried.
		if (result.some((addr) => addr.startsWith('127.'))) {
			return { status: 'listed', answers: boundedAnswers(result), retryable: false };
		}
		logUnknown('uninterpretable_answer');
		return {
			status: 'unknown',
			answers: boundedAnswers(result),
			retryable: false,
			errorCode: 'uninterpretable_answer',
		};
	} catch (err: unknown) {
		const errorCode = safeDnsErrorCode(err);
		// NXDOMAIN/ENOTFOUND = not listed (this is the expected "clean" result)
		if (CLEAN_DNS_ERROR_CODES.has(errorCode)) {
			return { status: 'clean', answers: [], retryable: false };
		}
		// Resolver availability is not evidence of delisting. Preserve the last
		// confirmed decision (and fail closed for a never-observed address).
		logUnknown(errorCode);
		return { status: 'unknown', answers: [], retryable: true, errorCode };
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

/**
 * Check a single IP against a single applicable DNSBL zone, retrying transient
 * failures with exponential backoff inside a bounded budget.
 *
 * Only a THROWN transient failure is retried: `listed`, `clean` (NXDOMAIN) and
 * an answered reserved code are answers, not failures. A budget exhaustion
 * concludes `unknown` — never `clean`.
 */
export async function checkDnsbl(
	ip: string,
	listId: DnsblListId,
	zone: string,
	deps: DnsblLookupDeps = defaultLookupDeps
): Promise<DnsblStatus> {
	const now = deps.now ?? Date.now;
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	// Per-attempt lines drop to debug; this function owns the conclusion line.
	const attemptDeps: DnsblLookupDeps = { ...deps, quiet: true };
	const startedAt = now();
	let outcome: DnsblLookupResult = { status: 'unknown', answers: [], retryable: true };
	let attempts = 0;
	for (let attempt = 1; attempt <= LOOKUP_MAX_ATTEMPTS; attempt += 1) {
		attempts = attempt;
		outcome = await lookupDnsblZone(ip, listId, zone, attemptDeps);
		if (!outcome.retryable) break;
		if (attempt === LOOKUP_MAX_ATTEMPTS) break;
		const delay = LOOKUP_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
		const elapsed = now() - startedAt;
		// The budget bounds the WHOLE conversation, so the next attempt's own
		// timeout counts against it — otherwise a hanging resolver overruns the
		// declared bound by a full LOOKUP_TIMEOUT_MS. Clock skew (a non-monotonic
		// `now`) must never extend the budget either.
		if (
			!Number.isFinite(elapsed) ||
			elapsed < 0 ||
			elapsed + delay + (deps.timeoutMs ?? LOOKUP_TIMEOUT_MS) > LOOKUP_TOTAL_BUDGET_MS
		) {
			break;
		}
		await sleep(delay);
	}
	// One line, at the conclusion, carrying how many attempts it took.
	if (outcome.status === 'unknown') {
		const fields = { ip, listId, errorCode: outcome.errorCode ?? 'unknown', attempts };
		if (deps.quiet) logger.debug(fields, 'DNSBL check is unknown');
		else logger.warn(fields, 'DNSBL check is unknown');
	}
	return outcome.status;
}
