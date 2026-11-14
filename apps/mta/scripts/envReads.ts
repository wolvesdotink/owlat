/**
 * The one list of environment variables the MTA reads, taken from its source.
 *
 * Two gates depend on it: `check-env-example.ts` (every read is documented in
 * apps/mta/.env.example) and scripts/__tests__/compose-mta-env.test.ts (every
 * read is forwarded by both compose files). They used to scan with their own
 * patterns and drifted: the env-example lint looked at two files and did not
 * know `intEnv`, so it passed with undocumented variables.
 *
 * A read is any key passed to `process.env`, to an `env` map, to the config
 * loader's `optionalEnv` / `requiredEnv` / `intEnv` helpers or a helper handed
 * `optionalEnv`, and the variable names given to the shared TLS loader.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
export const MTA_SOURCE = join(REPOSITORY_ROOT, 'apps/mta/src');

const NAME = String.raw`'([A-Z][A-Z0-9_]*)'`;
const READ_SHAPES = [
	new RegExp(String.raw`process\.env\[\s*${NAME}\s*\]`, 'g'),
	/process\.env\.([A-Z][A-Z0-9_]*)/g,
	new RegExp(String.raw`\benv\[\s*${NAME}\s*\]`, 'g'),
	new RegExp(String.raw`\b(?:optionalEnv|requiredEnv|intEnv)\(\s*${NAME}`, 'g'),
	new RegExp(String.raw`\(\s*optionalEnv\s*,\s*${NAME}`, 'g'),
	new RegExp(String.raw`\b(?:inlineCert|inlineKey|certFile|keyFile):\s*${NAME}`, 'g'),
];
const STRING_DEFAULT = new RegExp(String.raw`\boptionalEnv\(\s*${NAME},\s*'([^']*)'\s*\)`, 'g');
const INT_DEFAULT = new RegExp(String.raw`\bintEnv\(\s*${NAME},\s*([0-9][0-9_]*)\b`, 'g');
const FALLBACK_DEFAULT = new RegExp(
	String.raw`process\.env\[\s*${NAME}\s*\]\s*\?\?\s*'([^']*)'`,
	'g'
);
/** An upper-case string literal: in an env-reading module, usually a variable name. */
export const UPPER_LITERAL = /'([A-Z][A-Z0-9_]{2,})'/g;

export interface SourceFile {
	path: string;
	text: string;
}

/** Every non-test `.ts` file under `directory`, with repository-relative paths. */
export function mtaSourceFiles(directory: string = MTA_SOURCE): SourceFile[] {
	const walk = (dir: string): string[] =>
		readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(path);
			return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
		});
	return walk(directory).map((path) => ({
		path: relative(REPOSITORY_ROOT, path),
		text: readFileSync(path, 'utf8'),
	}));
}

/** Variable name → the source files that read it. */
export function mtaEnvReads(sources: readonly SourceFile[]): Map<string, string[]> {
	const reads = new Map<string, string[]>();
	for (const { path, text } of sources) {
		for (const shape of READ_SHAPES) {
			for (const match of text.matchAll(shape)) {
				const files = reads.get(match[1]!) ?? [];
				if (!files.includes(path)) files.push(path);
				reads.set(match[1]!, files);
			}
		}
	}
	return reads;
}

/** Literal defaults the config loader states, normalised to compose's spelling. */
export function mtaCodeDefaults(sources: readonly SourceFile[]): Map<string, string> {
	const defaults = new Map<string, string>();
	for (const { text } of sources) {
		for (const shape of [STRING_DEFAULT, FALLBACK_DEFAULT]) {
			for (const match of text.matchAll(shape)) defaults.set(match[1]!, match[2]!);
		}
		for (const match of text.matchAll(INT_DEFAULT)) {
			defaults.set(match[1]!, match[2]!.replaceAll('_', ''));
		}
	}
	return defaults;
}

/** The reads an env example neither sets nor shows commented out (`# NAME=`), sorted. */
export function undocumentedReads(
	reads: ReadonlyMap<string, readonly string[]>,
	envExample: string
): string[] {
	const documented = new Set(
		[...envExample.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]!)
	);
	return [...reads.keys()].filter((name) => !documented.has(name)).sort();
}
