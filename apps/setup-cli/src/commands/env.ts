/* eslint-disable no-console */
/**
 * `owlat-setup env <KEY> <VALUE>` — set a single env var in the install's
 * .env file. Validates the key (must look like a shell-safe identifier).
 */

import { join } from 'node:path';
import pc from 'picocolors';
import { readEnv, writeEnv } from '../lib/env';

interface EnvCmdOptions {
	owlatDir: string;
	positional: string[];
}

export async function runEnv(opts: EnvCmdOptions): Promise<number> {
	const [key, ...valueParts] = opts.positional;
	if (!key || valueParts.length === 0) {
		console.error('Usage: owlat-setup env <KEY> <VALUE>');
		return 1;
	}

	if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
		console.error(`Invalid env var name: ${key} (must be uppercase identifier).`);
		return 1;
	}

	const value = valueParts.join(' ');
	const envPath = join(opts.owlatDir, '.env');
	const existing = await readEnv(envPath);
	existing[key] = value;
	await writeEnv(envPath, existing);

	const masked = key.endsWith('_KEY') || key.endsWith('_SECRET') || key.endsWith('_PASSWORD')
		? '*'.repeat(Math.min(value.length, 8)) + '…'
		: value;

	console.log(`${pc.green('✓')} ${key} = ${masked}`);
	console.log(`\nRun ${pc.cyan('owlat restart')} to apply.`);
	return 0;
}
