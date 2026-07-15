import { access, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pluginKitDist = join(workspaceRoot, 'packages/plugin-kit/dist');

await rm(pluginKitDist, { force: true, recursive: true });

const test = spawnSync(
	process.execPath,
	[
		'run',
		'--cwd',
		'apps/api',
		'test',
		'--',
		'convex/plugins/__tests__/featureFlagRegistry.test.ts',
	],
	{ cwd: workspaceRoot, stdio: 'inherit' }
);
if (test.error) throw test.error;
if (test.status !== 0) {
	throw new Error(`Clean API plugin graph test failed with status ${test.status}`);
}

try {
	await access(pluginKitDist);
	throw new Error('API plugin graph test unexpectedly depended on rebuilding plugin-kit dist');
} catch (error) {
	if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
}

console.info('API tests load the generated plugin composition without plugin-kit build artifacts.');
