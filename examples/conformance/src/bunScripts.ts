/**
 * Run the repository's plugin scripts the way a developer does: in a Bun child
 * process, with the deployment as its working directory.
 *
 * Under Vitest an imported module's exports are accessor properties, and the
 * codegen loader deliberately never reads an accessor default export. A real
 * plugin's own source therefore cannot be loaded in-process here, while a Bun
 * process gives it a plain module namespace, as production codegen does.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { REPOSITORY_ROOT } from './repository';

export interface ScriptResult {
	readonly status: number | null;
	/** stdout then stderr, for the assertion message and for output checks. */
	readonly output: string;
}

/**
 * Make a disposable deployment look enough like a checkout for the scripts:
 * the `packages/plugin-codegen` marker `findWorkspaceRoot` looks for, and the
 * `@owlat/plugin-kit` a real install resolves a plugin's kit import to (Bun links
 * a published plugin's kit dependency to the checkout's workspace package). The
 * kit link sits outside the plugin package, so provenance, which checks only the
 * plugin's own files, is unaffected.
 */
export async function prepareForScripts(root: string): Promise<void> {
	await mkdir(join(root, 'packages', 'plugin-codegen'), { recursive: true });
	await mkdir(join(root, 'node_modules', '@owlat'), { recursive: true });
	await symlink(
		join(REPOSITORY_ROOT, 'packages', 'plugin-kit'),
		join(root, 'node_modules', '@owlat', 'plugin-kit'),
		'dir'
	);
}

export function runRepositoryScript(
	cwd: string,
	script: string,
	args: readonly string[]
): ScriptResult {
	// The child must not inherit this run's Vitest wiring.
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST'))
	);
	const result = spawnSync(
		process.versions['bun'] ? process.execPath : 'bun',
		[join(REPOSITORY_ROOT, script), ...args],
		{ cwd, encoding: 'utf8', env }
	);
	if (result.error) throw result.error;
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
