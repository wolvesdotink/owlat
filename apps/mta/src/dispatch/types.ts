/**
 * Shared types for the Dispatch attempt — the per-job execution path that
 * runs through the **Dispatch pipeline** and **Dispatch outcome** modules.
 *
 * See `docs/adr/0007-mta-dispatch-modules.md` and CONTEXT.md's MTA dispatch
 * section for the vocabulary.
 */

import type Redis from 'ioredis';
import type { EmailJob, IpPoolType } from '../types.js';
import type { DestinationSnapshot } from '../smtp/destinationProvider.js';
import type { MtaConfig } from '../config.js';

/**
 * The base context every Phase receives — derived purely from the job and
 * available at the start of the attempt.
 */
export interface BasePhaseCtx {
	readonly job: EmailJob;
	readonly domain: string;
	readonly destination: DestinationSnapshot;
	readonly fromDomain: string | undefined;
}

/**
 * The ctx after `resolvePool` enriches it.
 */
export interface CtxWithPool extends BasePhaseCtx {
	readonly pool: IpPoolType;
	readonly dedicatedIp: string | undefined;
}

/**
 * The ctx after `selectIp` enriches it.
 */
export interface CtxWithIp extends CtxWithPool {
	readonly ip: string;
	readonly eligibilityGeneration: number;
}

/**
 * The ctx fed into the outcome reducer once the SMTP send returns.
 *
 * Equivalent to the final pipeline output ctx plus the measured attempt
 * duration. Named separately because the reducer treats it as immutable
 * input.
 */
export interface AttemptCtx extends CtxWithIp {
	readonly durationMs: number;
}

/**
 * Dependencies the pipeline runner and effect runner consume.
 *
 * Phases never import the Redis client or the MtaConfig directly — they read
 * what they need off this struct so tests can substitute a stub.
 */
export interface PhaseDeps {
	readonly redis: Redis;
	readonly config: MtaConfig;
}
