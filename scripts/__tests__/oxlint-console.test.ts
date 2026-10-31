/**
 * no-console is an error everywhere except in maintenance scripts and CLI
 * programs, whose console output is what the program produces. oxlint matches
 * an override's `files` against a path whose form depends on the directory it
 * runs from, so an override can look right and match nothing from one of
 * them. These fixtures lay out a miniature repository with the real no-console
 * rule and its overrides from oxlintrc.json, then run the locked oxlint the way
 * the root gates do (from the root) and the way a workspace `lint` script does
 * (from the workspace with `--config ../../oxlintrc.json`).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LintDiagnostic, parseLintReport } from '../lint-diagnostics';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OXLINT = join(REPOSITORY_ROOT, 'node_modules/.bin/oxlint');

interface OxlintConfig {
	rules: Record<string, unknown>;
	overrides?: { files: string[]; rules: Record<string, unknown> }[];
}

/** The repository's no-console policy alone: the global rule and its overrides. */
function consolePolicy(): OxlintConfig {
	const text = readFileSync(join(REPOSITORY_ROOT, 'oxlintrc.json'), 'utf8');
	const { config, error } = ts.parseConfigFileTextToJson('oxlintrc.json', text);
	if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
	const { rules, overrides = [] } = config as OxlintConfig;
	return {
		rules: { 'no-console': rules['no-console'] },
		overrides: overrides
			.filter((override) => 'no-console' in override.rules)
			.map(({ files, rules: overrideRules }) => ({
				files,
				rules: { 'no-console': overrideRules['no-console'] },
			})),
	};
}

const LOG = "console.log('wrote 3 files');\n";
const OTHER_OUTPUT = "console.info('a');\nconsole.warn('b');\nconsole.error('c');\n";

const FIXTURES: Record<string, string> = {
	'scripts/report.ts': LOG,
	'scripts/debugging.ts': "console.debug('state');\n",
	'apps/desktop/scripts/spike.mjs': LOG,
	'apps/desktop/src/main.ts': LOG,
	'apps/desktop/src/status.ts': OTHER_OUTPUT,
	'packages/shared/scripts/update.ts': LOG,
	'packages/shared/src/lib.ts': LOG,
	'packages/shared/src/scripts.ts': LOG,
	'apps/setup-cli/src/index.ts': LOG,
	'apps/setup-cli/src/commands/env.ts': LOG,
	'apps/setup-cli/src/lib/run.ts': LOG,
	'packages/email-renderer/src/preview/generate.ts': LOG,
	'packages/email-renderer/src/preview/fixtures.ts': LOG,
};

/** CLI programs outside a scripts directory, by workspace: output allowed, then not. */
const CLI_PROGRAMS: Record<string, { output: string[]; source: string[] }> = {
	'apps/setup-cli': {
		output: ['src/index.ts', 'src/commands/env.ts'],
		source: ['src/lib/run.ts'],
	},
	'packages/email-renderer': {
		output: ['src/preview/generate.ts'],
		source: ['src/preview/fixtures.ts'],
	},
};

let root = '';

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'owlat-oxlint-console-'));
	writeFileSync(join(root, 'oxlintrc.json'), JSON.stringify(consolePolicy()));
	for (const [path, source] of Object.entries(FIXTURES)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), source);
	}
});

afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

/** Runs oxlint from `cwd` (relative to the fixture root) over `targets`. */
function lint(cwd: string, config: string, targets: string[]): LintDiagnostic[] {
	const directory = join(root, cwd);
	const run = spawnSync(OXLINT, ['--config', config, '--format', 'json', ...targets], {
		cwd: directory,
		encoding: 'utf8',
	});
	if (run.error) throw run.error;
	return parseLintReport(run.stdout).map((diagnostic) => ({
		...diagnostic,
		filename: resolve(directory, diagnostic.filename),
	}));
}

/** `severity code` of each diagnostic on the fixture at `path`, matched by full path. */
const findings = (diagnostics: LintDiagnostic[], path: string): string[] =>
	diagnostics
		.filter((diagnostic) => diagnostic.filename === join(root, path))
		.map((diagnostic) => `${diagnostic.severity} ${diagnostic.code ?? ''}`);

const NO_CONSOLE_ERROR = 'error eslint(no-console)';

describe('no-console from the repository root', () => {
	let diagnostics: LintDiagnostic[] = [];
	beforeAll(() => {
		diagnostics = lint('.', 'oxlintrc.json', ['apps', 'packages', 'scripts']);
	});

	it('fails console.log in application and library source', () => {
		expect(findings(diagnostics, 'apps/desktop/src/main.ts')).toEqual([NO_CONSOLE_ERROR]);
		expect(findings(diagnostics, 'packages/shared/src/lib.ts')).toEqual([NO_CONSOLE_ERROR]);
	});

	it('fails a file named after scripts outside a scripts directory', () => {
		expect(findings(diagnostics, 'packages/shared/src/scripts.ts')).toEqual([NO_CONSOLE_ERROR]);
	});

	it('keeps console.info, console.warn and console.error allowed in source', () => {
		expect(findings(diagnostics, 'apps/desktop/src/status.ts')).toEqual([]);
	});

	it('allows console.log as the output of a script in every scripts directory form', () => {
		expect(findings(diagnostics, 'scripts/report.ts')).toEqual([]);
		expect(findings(diagnostics, 'apps/desktop/scripts/spike.mjs')).toEqual([]);
		expect(findings(diagnostics, 'packages/shared/scripts/update.ts')).toEqual([]);
	});

	it('still fails console methods a script does not use for output', () => {
		expect(findings(diagnostics, 'scripts/debugging.ts')).toEqual([NO_CONSOLE_ERROR]);
	});

	it('allows console.log in CLI programs and fails it in their library code', () => {
		for (const [workspace, { output, source }] of Object.entries(CLI_PROGRAMS)) {
			for (const path of output) expect(findings(diagnostics, `${workspace}/${path}`)).toEqual([]);
			for (const path of source) {
				expect(findings(diagnostics, `${workspace}/${path}`)).toEqual([NO_CONSOLE_ERROR]);
			}
		}
	});
});

describe.each(Object.entries(CLI_PROGRAMS))(
	'no-console from the %s CLI workspace',
	(workspace, { output, source }) => {
		let diagnostics: LintDiagnostic[] = [];
		beforeAll(() => {
			diagnostics = lint(workspace, '../../oxlintrc.json', ['src']);
		});

		it('allows console.log in the CLI entry points', () => {
			for (const path of output) expect(findings(diagnostics, `${workspace}/${path}`)).toEqual([]);
		});

		it('fails console.log in the code the CLI imports', () => {
			for (const path of source) {
				expect(findings(diagnostics, `${workspace}/${path}`)).toEqual([NO_CONSOLE_ERROR]);
			}
		});
	}
);

describe.each(['apps/desktop', 'packages/shared'])(
	'no-console from the %s workspace',
	(workspace) => {
		let diagnostics: LintDiagnostic[] = [];
		beforeAll(() => {
			diagnostics = lint(workspace, '../../oxlintrc.json', ['src', 'scripts']);
		});

		it('fails console.log in the workspace source', () => {
			const source = workspace === 'apps/desktop' ? 'src/main.ts' : 'src/lib.ts';
			expect(findings(diagnostics, `${workspace}/${source}`)).toEqual([NO_CONSOLE_ERROR]);
		});

		it('allows console.log in the workspace scripts', () => {
			const script = workspace === 'apps/desktop' ? 'scripts/spike.mjs' : 'scripts/update.ts';
			expect(findings(diagnostics, `${workspace}/${script}`)).toEqual([]);
		});
	}
);
