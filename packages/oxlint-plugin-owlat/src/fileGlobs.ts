/**
 * Repository-relative file globs for rule options (`*`, `**`, `?`), matched as
 * a path SUFFIX at a directory boundary rather than against the working
 * directory: oxlint runs from the repository root (the root gates) and from
 * each workspace (its `lint` script) with the same config, and its own
 * `overrides` globs resolve against whichever directory that is, so a rule
 * that is scoped by an override would apply in one run and not the other.
 */

const REGEXP_SYNTAX = /[.+^${}()|[\]\\]/gu;
const compiled = new Map<string, RegExp>();

export const globToRegExp = (glob: string): RegExp => {
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

/** True when `filename` (any separator) matches one of `globs`. */
export const matchesFileGlobs = (filename: string, globs: readonly string[]): boolean => {
	const path = filename.replaceAll('\\', '/');
	return globs.some((glob) => globToRegExp(glob).test(path));
};
