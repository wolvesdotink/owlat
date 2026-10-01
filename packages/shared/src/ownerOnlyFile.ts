/**
 * Owner-only writes for files that hold deployment secrets (`.env`).
 *
 * NODE-ONLY: uses `node:fs`. Exposed via the `@owlat/shared/ownerOnlyFile`
 * subpath ONLY; it must never be re-exported from the `.` barrel, which has to
 * stay browser-safe.
 *
 * `writeFile(path, data, { mode: 0o600 })` applies the mode only when it
 * creates the file. An existing `.env` keeps the mode it had, so a file copied
 * from an example under a default umask stays readable by other local users
 * after setup writes secrets into it. {@link writeOwnerOnlyFile} sets the mode
 * on the open file and checks that it took before writing anything, and
 * refuses to write when it did not.
 *
 * The file is rewritten in place, not replaced through a temp file and a
 * rename. The setup and updater containers see `.env` through a bind mount,
 * and an operator may mount the file on its own, where a rename onto it fails.
 * An in-place write also keeps the file's owner and group, which a rename by a
 * different user (root in the setup container) would change.
 */

import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

const OWNER_ONLY_MODE = 0o600;

/** Any group or other permission bit. */
const NON_OWNER_BITS = 0o077;

/**
 * Write `data` to `path` as an owner-only (0600) file, creating it if needed.
 *
 * Throws, leaving an existing file's contents as they were, when the mode
 * cannot be set (the process does not own the file) or the filesystem does not
 * keep it.
 */
export async function writeOwnerOnlyFile(path: string, data: string): Promise<void> {
	// No O_TRUNC: the old contents stay until the mode is secured, so a refusal
	// changes nothing.
	const handle = await open(path, constants.O_WRONLY | constants.O_CREAT, OWNER_ONLY_MODE);
	try {
		await secureMode(handle, path);
		await handle.truncate(0);
		await handle.writeFile(data, 'utf-8');
	} finally {
		await handle.close();
	}
}

async function secureMode(handle: FileHandle, path: string): Promise<void> {
	// Windows has no group/other mode bits to tighten; chmod there only
	// toggles the read-only flag.
	if (process.platform === 'win32') return;
	try {
		await handle.chmod(OWNER_ONLY_MODE);
	} catch (err) {
		throw new Error(
			`Refusing to write ${path}: could not make it owner-only (chmod 600): ${
				err instanceof Error ? err.message : String(err)
			}. It holds deployment secrets. Run the command as the file's owner, or run ` +
				`\`chmod 600\` on it as its owner, then retry.`,
			{ cause: err }
		);
	}
	const { mode } = await handle.stat();
	if ((mode & NON_OWNER_BITS) !== 0) {
		throw new Error(
			`Refusing to write ${path}: its mode is still ${(mode & 0o777).toString(8)} after ` +
				'chmod 600, so this filesystem does not keep file permissions. It holds deployment ' +
				'secrets; keep the install directory on a filesystem that does.'
		);
	}
}
