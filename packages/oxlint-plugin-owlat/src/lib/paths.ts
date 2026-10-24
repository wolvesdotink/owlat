/**
 * Path scoping shared by the boundary rules. Rule options hold
 * repository-relative globs matched as a path suffix (see `../fileGlobs.ts`),
 * so a scope reads the same whether oxlint runs from the repository root or
 * from a workspace.
 */
import { globToRegExp } from '../fileGlobs.ts';

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
