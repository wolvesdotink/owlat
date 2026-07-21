/**
 * Reads from the repository the gallery is checked into.
 *
 * Several conformance invariants are only meaningful against the REAL files —
 * the core navigation the host builds its sidebar from, the `package.json` each
 * reference actually publishes. Copying those values into the suite would pin
 * the copy, not the source, so everything that must track core is read from
 * disk here.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, resolved from this module rather than the process cwd. */
export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Read one repository-relative UTF-8 file. */
export async function readRepositoryFile(path: string): Promise<string> {
	return readFile(join(REPOSITORY_ROOT, path), 'utf8');
}
