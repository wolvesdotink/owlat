/**
 * The per-provider cap gate exactly as the dispatch phase resolves it: the one
 * batched advisory read, then the pure verdict against the authoritative per-IP
 * daily cap.
 *
 * The store exposes no `checkProviderCap` of its own — production reads the
 * whole gate-input set in one round trip and applies the cap purely — so this
 * helper exists so the suites assert against the path production actually takes
 * rather than a convenience wrapper nothing calls.
 */

import type Redis from 'ioredis';
import {
	providerCapVerdict,
	readWarmingCapGateInputs,
	type ProviderCapCheck,
	type ProviderWarmingRef,
} from '../../warmingProviderStore.js';

export async function resolveProviderCap(
	redis: Redis,
	ref: ProviderWarmingRef,
	dailyCap: number
): Promise<ProviderCapCheck> {
	return providerCapVerdict(await readWarmingCapGateInputs(redis, ref), dailyCap);
}
