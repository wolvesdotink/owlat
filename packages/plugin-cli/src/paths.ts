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

/**
 * Compare two strings for a stable, ascending lexicographic sort.
 *
 * Ordering is by UTF-16 code unit — identical to the platform default
 * `Array.prototype.sort()` for the all-ASCII values the CLI sorts (kebab-case
 * plugin ids, npm package names, POSIX scaffold paths, capability strings). It
 * is spelled out so the sort's intent is explicit at every call site rather
 * than resting on the default comparator's implicit contract.
 */
export function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
