/**
 * owlat/no-test-environment-pragma (packages/oxlint-plugin-owlat) allows a
 * per-file `@vitest-environment` pragma only where oxlintrc.json lists it. An
 * allowance outlives its reason silently: the file is deleted or renamed, or
 * the pragma goes, and the entry then waves through whatever later lands at
 * that path. Lint cannot see that (it only reads the files that exist), so this
 * keeps the list exact: every listed file exists and still carries the pragma
 * it is allowed, and every listed glob still matches at least one such file.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.nuxt', '.output', 'coverage']);

interface Allowance {
	environment: string;
	files: string[];
}

function allowances(): Allowance[] {
	const text = readFileSync(join(REPOSITORY_ROOT, 'oxlintrc.json'), 'utf8');
	const { config, error } = ts.parseConfigFileTextToJson('oxlintrc.json', text);
	if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
	const entry = (config as { rules: Record<string, unknown> }).rules[
		'owlat/no-test-environment-pragma'
	];
	if (!Array.isArray(entry)) return [];
	return ((entry[1] as { allow?: Allowance[] } | undefined)?.allow ?? []) as Allowance[];
}

const carriesPragma = (file: string, environment: string): boolean =>
	new RegExp(
		`^[\\s/*]*@vitest-environment[ \\t]+${environment.replace(/[-.]/g, '\\$&')}\\b`,
		'm'
	).test(readFileSync(join(REPOSITORY_ROOT, file), 'utf8'));

/** Every .ts file under a repo-relative directory, outside build output. */
function walk(directory: string): string[] {
	if (!existsSync(join(REPOSITORY_ROOT, directory))) return [];
	return readdirSync(join(REPOSITORY_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
		const path = `${directory}/${entry.name}`;
		if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : walk(path);
		return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
	});
}

describe('owlat/no-test-environment-pragma allowances in oxlintrc.json', () => {
	const allowed = allowances();

	it('are configured', () => {
		expect(allowed.length).toBeGreaterThan(0);
	});

	it('list only files that exist and still carry the allowed pragma', () => {
		const stale = allowed.flatMap(({ environment, files }) =>
			files
				.filter((file) => !/[*?]/.test(file))
				.filter(
					(file) => !existsSync(join(REPOSITORY_ROOT, file)) || !carriesPragma(file, environment)
				)
				.map((file) => `${file} (${environment})`)
		);
		expect(stale).toEqual([]);
	});

	it('list only globs that still match a file carrying the allowed pragma', () => {
		const stale = allowed.flatMap(({ environment, files }) =>
			files
				.filter((glob) => /[*?]/.test(glob))
				.filter((glob) => {
					const base = glob.slice(0, glob.search(/[*?]/)).replace(/\/[^/]*$/, '');
					return !walk(base).some((file) => carriesPragma(file, environment));
				})
				.map((glob) => `${glob} (${environment})`)
		);
		expect(stale).toEqual([]);
	});
});
