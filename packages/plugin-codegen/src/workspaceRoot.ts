import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PluginCodegenError } from './errors';

/**
 * Walk upward from `start` to the Owlat workspace root: the first ancestor that
 * holds a `package.json`, the checked-in `plugins.config.ts` composition point,
 * and the `packages/plugin-codegen` deterministic codegen. Every plugin CLI and
 * codegen entry point resolves the root the same way so they operate on one
 * config and one generated tree regardless of the caller's cwd.
 */
export async function findWorkspaceRoot(start: string): Promise<string> {
	let current = resolve(start);
	for (;;) {
		try {
			await Promise.all([
				access(join(current, 'package.json')),
				access(join(current, 'plugins.config.ts')),
				access(join(current, 'packages', 'plugin-codegen')),
			]);
			return current;
		} catch {
			const parent = dirname(current);
			if (parent === current) {
				throw new PluginCodegenError(
					'workspace_not_found',
					'Run plugin codegen from inside the Owlat workspace'
				);
			}
			current = parent;
		}
	}
}
