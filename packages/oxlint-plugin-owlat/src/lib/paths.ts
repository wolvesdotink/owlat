/**
 * Path scoping shared by the rules. oxlint runs from the repository root (the
 * root lint gates) and from each workspace (`--config ../../oxlintrc.json`),
 * and its own `overrides` globs resolve against whichever directory that is.
 * Rule options therefore hold repository-relative globs (`*`, `**`, `?`) that
 * are matched as a path suffix at a directory boundary, which reads the same
 * from every working directory.
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

/** The linted file's name with forward slashes. */
export const slashed = (filename: string): string => filename.replaceAll('\\', '/');

export const matchesAny = (filename: string, globs: readonly string[] | undefined): boolean =>
	(globs ?? []).some((glob) => globToRegExp(glob).test(filename));

/**
 * Tests, fixtures and test helpers configure a test run rather than shipping
 * code, so none of the boundary rules read them.
 */
const TEST_FILES = ['**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*.testlib.*'] as const;

export interface ScopeOptions {
	/** The rule reads only files matching one of these; every file when absent. */
	files?: string[];
	/** Files the rule never reads, on top of the test files. */
	ignore?: string[];
}

/** A config-listed exemption: the files it covers and why. */
export interface Allowance {
	files: string[];
	reason: string;
}

export const inScope = (filename: string, options: ScopeOptions | undefined): boolean =>
	(options?.files === undefined || matchesAny(filename, options.files)) &&
	!matchesAny(filename, TEST_FILES) &&
	!matchesAny(filename, options?.ignore);

export const allowed = (filename: string, allow: readonly Allowance[] | undefined): boolean =>
	(allow ?? []).some(({ files }) => matchesAny(filename, files));

const GLOBS = { type: 'array', items: { type: 'string' } } as const;

/** JSON schema properties for `files` / `ignore` / `allow`, merged into each rule's schema. */
export const SCOPE_SCHEMA = {
	files: GLOBS,
	ignore: GLOBS,
} as const;

export const ALLOW_SCHEMA = {
	type: 'array',
	items: {
		type: 'object',
		properties: { files: GLOBS, reason: { type: 'string', minLength: 1 } },
		required: ['files', 'reason'],
		additionalProperties: false,
	},
} as const;
