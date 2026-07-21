import { access, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pluginKitDist = join(workspaceRoot, 'packages/plugin-kit/dist');

await rm(pluginKitDist, { force: true, recursive: true });

const check = spawnSync(process.execPath, ['run', 'plugins:check'], {
	cwd: workspaceRoot,
	stdio: 'inherit',
});
if (check.error) throw check.error;
if (check.status !== 0) {
	throw new Error(`Clean-checkout plugin composition check failed with status ${check.status}`);
}

await Promise.all([
	access(join(pluginKitDist, 'index.js')),
	access(join(pluginKitDist, 'index.d.ts')),
]);

console.info(
	'Plugin composition check rebuilt its public contract dependency from clean artifacts.'
);
