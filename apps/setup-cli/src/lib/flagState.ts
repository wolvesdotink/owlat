/**
 * Flag-state I/O — load, apply, persist, write override.
 *
 * `feature.ts` and `pack.ts` previously duplicated the same five-step
 * sequence (load `.owlat-flags.json`, apply the cascade, persist the new
 * state, regenerate `docker-compose.override.yml`, report which profiles
 * activated). This module centralises that transaction so the commands
 * become thin: declare the toggle, call `applyAndPersist`, print the result.
 *
 * The on-disk schema is intentionally simple — a single JSON file with the
 * resolved `FeatureFlagState`. Convex's `instanceSettings.featureFlags` is
 * the canonical store at runtime; this file is the CLI-side mirror so
 * scripted / pre-boot flows can flip flags without a running stack.
 */

import { join } from 'node:path';
import {
	applyToggle,
	applyPackToggle,
	FEATURE_FLAGS,
	type FeatureFlagState,
	type FeatureFlagKey,
	type FeaturePackKey,
} from '@owlat/shared/featureFlags';
import { writeComposeOverride } from './override';

const STATE_FILE = '.owlat-flags.json';
const OVERRIDE_FILE = 'docker-compose.override.yml';

/** Load the current flag state from `<owlatDir>/.owlat-flags.json`. */
export async function loadFlagState(owlatDir: string): Promise<FeatureFlagState> {
	const statePath = join(owlatDir, STATE_FILE);
	try {
		const file = Bun.file(statePath);
		if (await file.exists()) {
			return JSON.parse(await file.text()) as FeatureFlagState;
		}
	} catch {
		// File missing or unreadable — fall through to defaults.
	}
	return {};
}

/** Persist a flag state to `<owlatDir>/.owlat-flags.json`. */
export async function saveFlagState(owlatDir: string, state: FeatureFlagState): Promise<void> {
	await Bun.write(join(owlatDir, STATE_FILE), JSON.stringify(state, null, 2));
}

/** Result of a flag toggle transaction. */
export interface ToggleResult {
	/** Resolved state after the toggle. */
	state: FeatureFlagState;
	/** Flags whose value changed because of cascade rules (not the one explicitly toggled). */
	cascaded: FeatureFlagKey[];
	/** Docker compose profiles active after the toggle. */
	profiles: string[];
}

/**
 * Apply a single flag toggle and persist everything: state file + compose
 * override. Returns the resolved state, the cascade trail, and the active
 * profiles for the caller to print.
 */
export async function applyAndPersist(
	owlatDir: string,
	key: FeatureFlagKey,
	value: boolean
): Promise<ToggleResult> {
	const current = await loadFlagState(owlatDir);
	const { next, cascaded } = applyToggle(current, key, value, FEATURE_FLAGS);
	const preserved = preservePluginOverrides(current, next);
	await saveFlagState(owlatDir, preserved);
	const profiles = await writeComposeOverride(join(owlatDir, OVERRIDE_FILE), preserved);
	return { state: preserved, cascaded, profiles };
}

/**
 * Apply a feature-pack toggle (flips every flag in the pack) and persist
 * everything. Cascade rules apply per-flag.
 */
export async function applyPackAndPersist(
	owlatDir: string,
	key: FeaturePackKey,
	value: boolean
): Promise<ToggleResult> {
	const current = await loadFlagState(owlatDir);
	const { next, cascaded } = applyPackToggle(current, key, value, FEATURE_FLAGS);
	const preserved = preservePluginOverrides(current, next);
	await saveFlagState(owlatDir, preserved);
	const profiles = await writeComposeOverride(join(owlatDir, OVERRIDE_FILE), preserved);
	return { state: preserved, cascaded, profiles };
}

/**
 * The setup CLI owns core flags but may run after bundled plugins have written
 * their namespaced overrides. Preserve those opaque booleans verbatim: runtime
 * composition remains responsible for deciding whether a plugin key is live.
 */
function preservePluginOverrides(
	current: FeatureFlagState,
	next: FeatureFlagState
): FeatureFlagState {
	const preserved = { ...next };
	for (const [key, value] of Object.entries(current)) {
		if (/^plugin\.[a-z][a-z0-9-]*$/.test(key) && typeof value === 'boolean') {
			preserved[key as `plugin.${string}`] = value;
		}
	}
	return preserved;
}
