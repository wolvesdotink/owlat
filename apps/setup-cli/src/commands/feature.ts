/* eslint-disable no-console */
/**
 * `owlat-setup feature <key> <on|off>` — toggle a single feature flag and
 * regenerate docker-compose.override.yml. Useful for scripted / CI flows.
 *
 * The on-disk side effects (load `.owlat-flags.json`, apply cascade, persist,
 * write override) are owned by `lib/flagState` so this command stays thin.
 */

import pc from 'picocolors';
import { FEATURE_FLAGS, type FeatureFlagKey } from '@owlat/shared/featureFlags';
import { applyAndPersist } from '../lib/flagState';

interface FeatureOptions {
	owlatDir: string;
	positional: string[];
}

export async function runFeature(opts: FeatureOptions): Promise<number> {
	const [key, valueArg] = opts.positional;
	if (!key || !valueArg) {
		console.error('Usage: owlat-setup feature <key> <on|off>');
		return 1;
	}

	if (!(key in FEATURE_FLAGS)) {
		console.error(`Unknown feature flag: ${key}`);
		console.error(`\nAvailable flags:\n  ${Object.keys(FEATURE_FLAGS).join('\n  ')}`);
		return 1;
	}

	const value = valueArg === 'on' || valueArg === 'true' || valueArg === '1';
	const { cascaded, profiles } = await applyAndPersist(
		opts.owlatDir,
		key as FeatureFlagKey,
		value,
	);

	console.log(`${pc.green('✓')} ${key} = ${value ? pc.green('on') : pc.red('off')}`);
	if (cascaded.length > 0) {
		console.log(`${pc.yellow('  Cascaded:')} ${cascaded.join(', ')}`);
	}
	console.log(`${pc.cyan('  Active profiles:')} ${profiles.join(', ') || '(none)'}`);
	console.log(`\nRun ${pc.cyan('owlat restart')} to apply.`);
	return 0;
}
