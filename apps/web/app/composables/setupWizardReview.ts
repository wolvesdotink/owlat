/**
 * What the setup wizard's review step shows, in the operator's terms (#773).
 *
 * The review used to list raw flag keys (`campaigns.archive`, `scan.content`)
 * as chips and leave Launch disabled with no reason next to it. This module
 * derives the two things the page needs instead:
 *
 *  - the active features grouped by the pack they belong to, so the page can
 *    name each one by its label under a pack heading;
 *  - every reason Launch is blocked, each pointing at the step (or field) that
 *    fixes it.
 *
 * Pure, so both are unit-testable without mounting the page. Copy is message
 * KEYS; the page resolves them.
 */

import {
	ALL_FEATURE_PACK_KEYS,
	FEATURE_PACKS,
	type FeatureFlagKey,
	type FeaturePackKey,
} from '@owlat/shared/featureFlags';
import { adminIsValid } from './setupWizardValidation';
import type { AdminDraft } from './useSetupWizard';

export interface ReviewFeatureGroup {
	/** The pack these features belong to, or `'other'` for flags outside every pack. */
	pack: FeaturePackKey | 'other';
	flags: FeatureFlagKey[];
}

/**
 * Group the active features by pack, in pack order, keeping each flag's
 * position from the input. Flags no pack claims (archive, scanning, DKIM
 * rotation, …) land in a trailing "other" group. Empty groups are dropped.
 */
export function groupActiveFeatures(active: readonly FeatureFlagKey[]): ReviewFeatureGroup[] {
	const packOf = new Map<string, FeaturePackKey>();
	for (const pack of ALL_FEATURE_PACK_KEYS) {
		for (const flag of FEATURE_PACKS[pack].flags) packOf.set(flag, pack);
	}

	const groups: ReviewFeatureGroup[] = [
		...ALL_FEATURE_PACK_KEYS.map((pack) => ({ pack, flags: [] as FeatureFlagKey[] })),
		{ pack: 'other' as const, flags: [] as FeatureFlagKey[] },
	];
	const byPack = new Map(groups.map((group) => [group.pack, group]));
	for (const flag of active) {
		byPack.get(packOf.get(flag) ?? 'other')?.flags.push(flag);
	}
	return groups.filter((group) => group.flags.length > 0);
}

export type LaunchBlockerId = 'provider' | 'admin' | 'token';

export interface LaunchBlocker {
	id: LaunchBlockerId;
	/** i18n key: what to do, phrased as the fix ("Create the admin account to continue"). */
	message: string;
	/** Where the fix lives: a wizard step route, or `#id` of a field on the review page. */
	to: string;
}

/** Id of the setup-token field on the review page, which the token blocker links to. */
export const SETUP_TOKEN_FIELD_ID = 'setup-token';

/**
 * Every reason Launch is disabled, in the order the operator meets them in the
 * wizard. An empty list means the operator can launch.
 */
export function launchBlockers(input: {
	missingProvider: boolean;
	admin: AdminDraft;
	setupToken: string;
}): LaunchBlocker[] {
	const blockers: LaunchBlocker[] = [];
	if (input.missingProvider) {
		blockers.push({
			id: 'provider',
			message: 'setup.review.blockers.provider',
			to: '/setup/email',
		});
	}
	if (!adminIsValid(input.admin)) {
		blockers.push({ id: 'admin', message: 'setup.review.blockers.admin', to: '/setup/admin' });
	}
	if (input.setupToken.trim() === '') {
		blockers.push({
			id: 'token',
			message: 'setup.review.blockers.token',
			to: `#${SETUP_TOKEN_FIELD_ID}`,
		});
	}
	return blockers;
}
