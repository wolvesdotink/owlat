/* eslint-disable no-console */
/**
 * `owlat-setup pack <key> <on|off>` — toggle every flag in a feature pack and
 * regenerate docker-compose.override.yml.
 *
 * Packs are UI groupings over atomic flags (emailClient = inbox + chat +
 * mail.compose; marketing = campaigns + automations + transactional; ai =
 * the full ai.* family). Cascade rules apply per flag. The on-disk side
 * effects are owned by `lib/flagState`.
 */

import pc from 'picocolors';
import {
	FEATURE_PACKS,
	ALL_FEATURE_PACK_KEYS,
	type FeaturePackKey,
} from '@owlat/shared/featureFlags';
import { applyPackAndPersist } from '../lib/flagState';

interface PackOptions {
	owlatDir: string;
	positional: string[];
}

export async function runPack(opts: PackOptions): Promise<number> {
	const [key, valueArg] = opts.positional;
	if (!key || !valueArg) {
		console.error('Usage: owlat-setup pack <key> <on|off>');
		console.error(`\nAvailable packs:\n  ${ALL_FEATURE_PACK_KEYS.join('\n  ')}`);
		return 1;
	}

	if (!(key in FEATURE_PACKS)) {
		console.error(`Unknown feature pack: ${key}`);
		console.error(`\nAvailable packs:\n  ${ALL_FEATURE_PACK_KEYS.join('\n  ')}`);
		return 1;
	}

	const value = valueArg === 'on' || valueArg === 'true' || valueArg === '1';
	const { cascaded, profiles } = await applyPackAndPersist(
		opts.owlatDir,
		key as FeaturePackKey,
		value,
	);

	const pack = FEATURE_PACKS[key as FeaturePackKey];
	console.log(`${pc.green('✓')} ${pack.label} = ${value ? pc.green('on') : pc.red('off')}`);
	console.log(`${pc.cyan('  Flags:')} ${pack.flags.join(', ')}`);
	if (cascaded.length > 0) {
		console.log(`${pc.yellow('  Cascaded:')} ${cascaded.join(', ')}`);
	}
	console.log(`${pc.cyan('  Active profiles:')} ${profiles.join(', ') || '(none)'}`);
	console.log(`\nRun ${pc.cyan('owlat restart')} to apply.`);
	return 0;
}
