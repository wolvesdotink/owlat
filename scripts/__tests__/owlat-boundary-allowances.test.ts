/**
 * The boundary rules in packages/oxlint-plugin-owlat (crypto, env, error
 * taxonomy, raw builders) exempt whole modules through `allow` entries in
 * oxlintrc.json, each with its reason. Lint only reads files that exist, so it
 * cannot tell when an entry has outlived that reason: the module was moved,
 * or stopped doing the thing it was exempted for, and the entry now waves
 * through whatever lands at that path. This keeps every entry exact: it names
 * an existing file, and with the entry removed the rule reports that file.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { PARALLEL_GATE_TIMEOUT_MS } from '../../vitest.timeouts';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RULES = [
	'owlat/no-crypto-primitives',
	'owlat/no-process-env',
	'owlat/convex-error-taxonomy',
	'owlat/no-raw-convex-builder',
];

interface Config {
	jsPlugins: string[];
	rules: Record<string, unknown>;
	[key: string]: unknown;
}

function config(): Config {
	const text = readFileSync(join(REPOSITORY_ROOT, 'oxlintrc.json'), 'utf8');
	const { config: parsed, error } = ts.parseConfigFileTextToJson('oxlintrc.json', text);
	if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
	return parsed as Config;
}

const allowances = (rule: string): { files: string[]; reason: string }[] => {
	const entry = config().rules[rule] as [string, { allow?: { files: string[]; reason: string }[] }];
	return entry[1].allow ?? [];
};

const workDirectory = mkdtempSync(join(tmpdir(), 'owlat-boundary-allowances-'));
afterAll(() => rmSync(workDirectory, { recursive: true, force: true }));

/** The files `rule` reports among `files` when its `allow` list is emptied. */
function reportedWithoutAllowances(rule: string, files: string[]): Set<string> {
	const base = config();
	const options = (base.rules[rule] as [string, Record<string, unknown>])[1];
	const stripped: Config = {
		...base,
		jsPlugins: base.jsPlugins.map((plugin) => join(REPOSITORY_ROOT, plugin)),
		categories: {},
		rules: { [rule]: ['error', { ...options, allow: [] }] },
		overrides: [],
	};
	const path = join(workDirectory, `${rule.replace('/', '-')}.json`);
	writeFileSync(path, JSON.stringify(stripped));
	const run = spawnSync(
		join(REPOSITORY_ROOT, 'node_modules/.bin/oxlint'),
		['--config', path, '--format', 'json', ...files],
		{ cwd: REPOSITORY_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
	);
	if (run.status !== 0 && run.status !== 1)
		throw new Error(`oxlint exited ${run.status}: ${run.stderr}`);
	const { diagnostics } = JSON.parse(run.stdout) as {
		diagnostics: { filename: string; code?: string }[];
	};
	return new Set(
		diagnostics
			.filter((d) => d.code === `owlat(${rule.slice('owlat/'.length)})`)
			.map((d) => d.filename)
	);
}

describe.each(RULES)('%s allowances in oxlintrc.json', (rule) => {
	const files = allowances(rule).flatMap((entry) => entry.files);

	it('each give a reason and name existing files, not globs', () => {
		expect(files.length).toBeGreaterThan(0);
		for (const entry of allowances(rule)) expect(entry.reason.trim()).not.toBe('');
		expect(files.filter((file) => /[*?]/.test(file))).toEqual([]);
		expect(files.filter((file) => !existsSync(join(REPOSITORY_ROOT, file)))).toEqual([]);
	});

	it(
		'each exempt a file the rule would otherwise report',
		() => {
			const reported = reportedWithoutAllowances(rule, files);
			expect(files.filter((file) => !reported.has(file))).toEqual([]);
		},
		PARALLEL_GATE_TIMEOUT_MS
	);
});
