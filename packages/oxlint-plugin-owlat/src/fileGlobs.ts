/**
 * Repository-relative file globs for rule options (`*`, `**`, `?`).
 *
 * They are matched as a path suffix at a directory boundary rather than against
 * the working directory, because oxlint runs from the repository root and from
 * each workspace with the same config, and its own `overrides` globs resolve
 * against whichever directory that is.
 */

const REGEXP_SYNTAX = /[.+^${}()|[\]\\]/gu;
const compiled = new Map<string, RegExp>();

const globToRegExp = (glob: string): RegExp => {
	const cached = compiled.get(glob);
	if (cached) return cached;
	let pattern = '';
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index] as string;
		if (char === '*' && glob[index + 1] === '*') {
			const slash = glob[index + 2] === '/';
			pattern += slash ? '(?:.*/)?' : '.*';
			index += slash ? 2 : 1;
		} else if (char === '*') {
			pattern += '[^/]*';
		} else if (char === '?') {
			pattern += '[^/]';
		} else {
			pattern += char.replace(REGEXP_SYNTAX, '\\$&');
		}
	}
	const regExp = new RegExp(`(?:^|/)${pattern}$`, 'u');
	compiled.set(glob, regExp);
	return regExp;
};

/** Whether `filename` (as oxlint reports it) matches any of the repository-relative `globs`. */
export const matchesAnyGlob = (filename: string, globs: readonly string[]): boolean => {
	const path = filename.replaceAll('\\', '/');
	return globs.some((glob) => globToRegExp(glob).test(path));
};
