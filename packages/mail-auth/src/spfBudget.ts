/** RFC 7208 DNS lookup and void-lookup budget shared by SPF mechanisms. */

import type { SpfDnsResolver, SpfResult } from './spf.js';

const MAX_SPF_DNS_LOOKUPS = 10;
const MAX_SPF_VOID_LOOKUPS = 2;

export interface SpfBudget {
	lookups: number;
	voids: number;
	visited: Set<string>;
}

/** Sentinel thrown to abort evaluation with a definite SPF result. */
export class SpfAbort {
	constructor(public readonly result: SpfResult) {}
}

/** Returns false when the RFC 7208 lookup budget is exhausted. */
export function consumeLookup(budget: SpfBudget): boolean {
	if (budget.lookups >= MAX_SPF_DNS_LOOKUPS) return false;
	budget.lookups += 1;
	return true;
}

/** Re-throw an SpfAbort so per-mechanism catch blocks cannot swallow it. */
export function rethrowAbort(err: unknown): void {
	if (err instanceof SpfAbort) throw err;
}

/** Resolve a DNS record while enforcing RFC 7208's void-lookup cap. */
export async function resolveCounted<T>(
	domain: string,
	type: 'A' | 'AAAA' | 'MX' | 'TXT',
	budget: SpfBudget,
	resolver: SpfDnsResolver
): Promise<T[]> {
	let records: T[];
	try {
		records = (await resolver(domain, type)) as unknown as T[];
	} catch (err: unknown) {
		const code = (err as { code?: string }).code;
		if (code === 'ENOTFOUND' || code === 'ENODATA') {
			countVoid(budget);
			return [];
		}
		throw err;
	}
	if (records.length === 0) countVoid(budget);
	return records;
}

function countVoid(budget: SpfBudget): void {
	budget.voids += 1;
	if (budget.voids > MAX_SPF_VOID_LOOKUPS) {
		throw new SpfAbort({
			result: 'permerror',
			explanation: 'SPF void DNS lookup limit exceeded',
		});
	}
}
