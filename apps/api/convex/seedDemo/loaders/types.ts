/**
 * Shared types for seedDemo loaders.
 *
 * Each loader exports a `Loader` object: it receives the fixture records and a
 * cross-loader `refs` map keyed by slug. Loaders insert rows directly into the
 * database — they bypass the public mutations to skip side effects like
 * `sendProviderDispatch`, `verifyDnsRecords`, and content scanning. See the
 * top of each loader for the specific bypass it relies on.
 */

import type { MutationCtx } from '../../_generated/server';
import type { GenericId } from 'convex/values';

export type SeedRefs = Record<string, Record<string, GenericId<string>>>;

export interface LoadResult {
	inserted: number;
	skipped: number;
	ids: Record<string, GenericId<string>>;
}

export interface Loader {
	module: string;
	/** Names of other loader modules that must run before this one. */
	dependencies: string[];
	load: (ctx: MutationCtx, records: unknown[], refs: SeedRefs) => Promise<LoadResult>;
}

export const SEED_TAG = 'demo';
