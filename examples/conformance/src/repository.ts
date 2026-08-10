/**
 * Reads from the repository the gallery is checked into.
 *
 * Several conformance invariants are only meaningful against the REAL files —
 * the core navigation the host builds its sidebar from, the `package.json` each
 * reference actually publishes. Copying those values into the suite would pin
 * the copy, not the source, so everything that must track core is read from
 * disk here.
 */

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, resolved from this module rather than the process cwd. */
export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Read one repository-relative UTF-8 file. */
export async function readRepositoryFile(path: string): Promise<string> {
	return readFile(join(REPOSITORY_ROOT, path), 'utf8');
}

/**
 * Every file under `apps/` and `packages/` that names any of `identifiers`.
 *
 * The "no core file knows this fixture exists" claim is the headline of both
 * plugin-parity suites, and it is the same `git grep` in both — same flags, same
 * cwd, same treatment of the empty result. One copy, so a change to the search
 * (a new pathspec, a different exit-code rule) cannot land in one suite and miss
 * the other.
 *
 * `--untracked` so a file added in this working tree counts. The empty result is
 * read off the exit STATUS rather than thrown: `git grep` exits 1 when it matches
 * nothing, which is the expected outcome here, while anything else (a bad
 * pathspec, no repository) still propagates.
 */
export function repositoryFilesMentioning(
	identifiers: readonly string[],
	options: { readonly exclude?: readonly string[] } = {}
): readonly string[] {
	const args = [
		'grep',
		'-lI',
		'--untracked',
		...identifiers.flatMap((identifier) => ['-e', identifier]),
		'--',
		'apps',
		'packages',
		...(options.exclude ?? []).map((pattern) => `:(exclude)${pattern}`),
	];
	try {
		return execFileSync('git', args, {
			cwd: REPOSITORY_ROOT,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		})
			.split('\n')
			.filter((line) => line.length > 0);
	} catch (error) {
		if ((error as { status?: number }).status === 1) return [];
		throw error;
	}
}
