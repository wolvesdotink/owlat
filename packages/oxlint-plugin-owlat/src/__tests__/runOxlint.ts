/**
 * Runs the real oxlint binary with the repository's root oxlintrc.json over a
 * fixture directory, the way the lint gates run it.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const OXLINT_BIN = join(
	dirname(createRequire(import.meta.url).resolve('oxlint/package.json')),
	'bin/oxlint'
);

export interface Diagnostic {
	filename: string;
	code?: string;
	message: string;
	severity: string;
}

/** Lint `fixtureDirectory` from `cwd` (repo-relative); diagnostics keyed by file name. */
export function lintFixtures(fixtureDirectory: string, cwd = '.'): Map<string, Diagnostic[]> {
	const directory = join(REPOSITORY_ROOT, cwd);
	const config = relative(directory, join(REPOSITORY_ROOT, 'oxlintrc.json'));
	const run = spawnSync(
		process.execPath,
		[OXLINT_BIN, '--config', config, '--format', 'json', fixtureDirectory],
		{ cwd: directory, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
	);
	if (run.status !== 0 && run.status !== 1) {
		throw new Error(`oxlint exited ${String(run.status)}: ${run.stderr}`);
	}
	const { diagnostics } = JSON.parse(run.stdout) as { diagnostics: Diagnostic[] };
	const byFile = new Map<string, Diagnostic[]>();
	for (const diagnostic of diagnostics) {
		const name = diagnostic.filename.split(/[\\/]/).at(-1)!;
		byFile.set(name, [...(byFile.get(name) ?? []), diagnostic]);
	}
	return byFile;
}
