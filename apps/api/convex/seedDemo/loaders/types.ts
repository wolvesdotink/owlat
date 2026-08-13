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

/**
 * Per-run switches every loader receives.
 *
 * `inert` is what makes the sample-data path safe on a REAL install: the same
 * fixtures, written in a state that cannot act on the operator's own data. An
 * `active` automation triggering on `contact_created` would mail the next real
 * signup a demo promo; an `isActive` webhook would POST that contact's details
 * to a fixture URL nobody configured. In inert mode those rows are written
 * paused / disabled instead, so the dataset is inert BY CONSTRUCTION rather
 * than by an operator noticing in time.
 *
 * The dev seed (`POST /seed/demo`) leaves it false and keeps the live rows it
 * has always had — that instance is a throwaway with no real contacts on it.
 */
export interface LoaderOptions {
	inert: boolean;
}

export interface Loader {
	module: string;
	/** Names of other loader modules that must run before this one. */
	dependencies: string[];
	load: (
		ctx: MutationCtx,
		records: unknown[],
		refs: SeedRefs,
		options: LoaderOptions
	) => Promise<LoadResult>;
}

export const SEED_TAG = 'demo';
