import { sep } from 'node:path';

/**
 * Normalize an OS-native path to a POSIX (`/`-separated) display path.
 *
 * On POSIX platforms `sep` is already `/`, so the input is returned unchanged;
 * on Windows the native separator is replaced so the CLI prints stable,
 * forward-slash paths regardless of host platform.
 */
export function toPosix(path: string): string {
	return sep === '/' ? path : path.split(sep).join('/');
}
