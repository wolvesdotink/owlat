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

import { readFile, writeFile } from 'node:fs/promises';
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
const ENV_FILE = '.env';

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
	const profiles = await persistProfiles(owlatDir, preserved);
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
	const profiles = await persistProfiles(owlatDir, preserved);
	return { state: preserved, cascaded, profiles };
}

/**
 * Write the compose override AND `.env`'s COMPOSE_PROFILES for a flag state,
 * so both records of the active profiles agree — the setup wizard and the
 * updater's Apply already write both. With only the override rewritten, a
 * profile disabled here stayed listed in `.env` and `owlat apply` (which reads
 * both) kept its service running.
 */
async function persistProfiles(owlatDir: string, flags: FeatureFlagState): Promise<string[]> {
	const profiles = await writeComposeOverride(join(owlatDir, OVERRIDE_FILE), flags);
	await writeEnvComposeProfiles(join(owlatDir, ENV_FILE), profiles);
	return profiles;
}

/**
 * Set COMPOSE_PROFILES in an existing `.env`, editing that one line (or
 * appending it) and leaving every other line and comment as it was. No `.env`
 * yet means no install to converge, so nothing is created.
 */
export async function writeEnvComposeProfiles(envPath: string, profiles: string[]): Promise<void> {
	let text: string;
	try {
		text = await readFile(envPath, 'utf-8');
	} catch {
		return;
	}
	const line = `COMPOSE_PROFILES=${profiles.join(',')}`;
	const next = /^[ \t]*COMPOSE_PROFILES[ \t]*=/m.test(text)
		? text.replace(/^[ \t]*COMPOSE_PROFILES[ \t]*=.*$/gm, line)
		: `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`;
	if (next !== text) await writeFile(envPath, next, 'utf-8');
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
