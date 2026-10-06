/**
 * Conformance for the Semgrep coverage check (`scripts/check-semgrep-timeouts.sh`).
 *
 * The cases run the REAL script against Semgrep `--time --json-output`
 * reports shaped like Semgrep 1.178's and pin what it prints, what it writes
 * to the job summary and how it exits: 1 on a fixpoint timeout, 2 when the
 * report cannot be checked, 0 otherwise. The last case pins the workflow
 * wiring the script's verdict depends on.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(REPOSITORY_ROOT, 'scripts/check-semgrep-timeouts.sh');
const run = promisify(execFile);

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots.length = 0;
});

function fixpointTimeout(path: string, line: number, col: number, rules: number, first: string) {
	return {
		error_type: 'Fixpoint timeout',
		severity: 'warn',
		message: `Fixpoint timeout while performing taint analysis at ${path}:${line}:${col} [rules: ${rules}, first: ${first}]`,
		location: {
			path,
			start: { line, col: col + 1, offset: 0 },
			end: { line, col: col + 1, offset: 0 },
		},
	};
}

const RULE_PARSE_ERROR = {
	code: 2,
	level: 'error',
	type: 'Rule parse error',
	rule_id: 'webhook-signature-presence-only',
	message:
		'Rule parse error in rule webhook-signature-presence-only:\n Invalid pattern for TypeScript: Stdlib.Parsing.Parse_error\n----- pattern -----\n$X = $FN(...) {\n}\n',
};

const PARTIAL_PARSING = {
	code: 3,
	level: 'warn',
	type: [
		'PartialParsing',
		[{ path: 'apps/api/convex/mail/outboundCron.ts', start: { line: 63, col: 1, offset: 0 } }],
	],
	message:
		"Syntax error at line apps/api/convex/mail/outboundCron.ts:63:\n `import('x')` was unexpected",
	path: 'apps/api/convex/mail/outboundCron.ts',
};

function report({
	timeouts = [] as unknown[],
	errors = [] as unknown[],
}: { timeouts?: unknown[]; errors?: unknown[] } = {}) {
	return JSON.stringify({
		results: [],
		errors,
		paths: { scanned: [] },
		time: { fixpoint_timeouts: timeouts, targets: [], total_bytes: 0, max_memory_bytes: 0 },
	});
}

async function check(
	contents: string | null,
	{ summary = true }: { summary?: boolean } = {}
): Promise<{ code: number; stdout: string; summary: string }> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-semgrep-check-'));
	roots.push(root);
	const reportPath = join(root, 'semgrep.json');
	if (contents !== null) await writeFile(reportPath, contents, 'utf8');
	const summaryPath = join(root, 'summary.md');
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env['GITHUB_STEP_SUMMARY'];
	if (summary) env['GITHUB_STEP_SUMMARY'] = summaryPath;
	let code = 0;
	let stdout: string;
	try {
		({ stdout } = await run('bash', [SCRIPT, reportPath], { env }));
	} catch (error) {
		const failed = error as { code: number; stdout: string };
		code = failed.code;
		stdout = failed.stdout;
	}
	const written = await readFile(summaryPath, 'utf8').catch(() => '');
	return { code, stdout, summary: written };
}

describe('check-semgrep-timeouts', () => {
	it('passes a clean report and writes zero counts to the summary', async () => {
		const result = await check(report());
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('0 fixpoint timeout(s), 0 error(s), 0 warning(s)');
		expect(result.stdout).not.toContain('::error');
		expect(result.summary).toContain('| Fixpoint timeouts | 0 |');
		expect(result.summary).not.toContain('### Fixpoint timeouts');
	});

	it('fails on fixpoint timeouts and annotates each function and top level', async () => {
		const result = await check(
			report({
				timeouts: [
					fixpointTimeout(
						'apps/api/convex/agent/steps/context_retrieval/index.ts',
						91,
						22,
						1,
						'typescript.react.security.audit.react-unsanitized-method.react-unsanitized-method'
					),
					fixpointTimeout(
						'apps/api/convex/contacts/import.ts',
						1,
						0,
						2,
						'javascript.express.security.injection.raw-html-format.raw-html-format'
					),
				],
			})
		);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain('2 fixpoint timeout(s)');
		expect(result.stdout).toContain(
			'::error file=apps/api/convex/agent/steps/context_retrieval/index.ts,line=91,title=Semgrep fixpoint timeout::Taint analysis of this function timed out for 1 rule(s) (first: typescript.react.security.audit.react-unsanitized-method.react-unsanitized-method)'
		);
		expect(result.stdout).toContain(
			'::error file=apps/api/convex/contacts/import.ts,line=1,title=Semgrep fixpoint timeout::Taint analysis of this top-level code timed out for 2 rule(s)'
		);
		expect(result.summary).toContain('| Fixpoint timeouts | 2 |');
		expect(result.summary).toContain(
			'| `apps/api/convex/agent/steps/context_retrieval/index.ts:91` | function | 1 | `typescript.react.security.audit.react-unsanitized-method.react-unsanitized-method` |'
		);
		expect(result.summary).toContain(
			'| `apps/api/convex/contacts/import.ts:1` | top-level code | 2 | `javascript.express.security.injection.raw-html-format.raw-html-format` |'
		);
	});

	it('reports errors and warnings without failing, annotating only error-level entries', async () => {
		const result = await check(report({ errors: [RULE_PARSE_ERROR, PARTIAL_PARSING] }));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('0 fixpoint timeout(s), 1 error(s), 1 warning(s)');
		expect(result.stdout).toContain(
			'::warning title=Semgrep Rule parse error::webhook-signature-presence-only: Rule parse error in rule webhook-signature-presence-only: Invalid pattern for TypeScript'
		);
		expect(result.stdout).toContain(
			'[warn] PartialParsing  apps/api/convex/mail/outboundCron.ts  Syntax error at line'
		);
		expect(result.stdout.match(/::warning/g)).toHaveLength(1);
		expect(result.summary).toContain('| Errors | 1 |');
		expect(result.summary).toContain('| Warnings | 1 |');
		expect(result.summary).toContain(
			'| warn | PartialParsing | `apps/api/convex/mail/outboundCron.ts` |'
		);
	});

	it('escapes workflow-command and table metacharacters', async () => {
		const result = await check(
			report({
				timeouts: [fixpointTimeout('apps/a,b:c.ts', 7, 2, 1, 'rule.with|pipe')],
				errors: [{ ...RULE_PARSE_ERROR, message: '100% broken | twice' }],
			})
		);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain('::error file=apps/a%2Cb%3Ac.ts,line=7,');
		expect(result.stdout).toContain('webhook-signature-presence-only: 100%25 broken | twice');
		expect(result.summary).toContain('| `apps/a,b:c.ts:7` | function | 1 | `rule.with\\|pipe` |');
		expect(result.summary).toContain('100% broken \\| twice');
	});

	it('still reports a timeout whose message it cannot parse', async () => {
		const result = await check(
			report({
				timeouts: [
					{
						error_type: 'Fixpoint timeout',
						severity: 'warn',
						message: 'Fixpoint timeout while performing svalue-propagation',
						location: { path: 'apps/x.ts', start: { line: 3, col: 1, offset: 0 } },
					},
				],
			})
		);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain('apps/x.ts:3  function, rules: ?, first: ?');
	});

	it('works without a job summary', async () => {
		const result = await check(report(), { summary: false });
		expect(result.code).toBe(0);
		expect(result.summary).toBe('');
	});

	it.each([
		['a missing report', null, 'is missing or empty'],
		['an empty report', '', 'is missing or empty'],
		['invalid JSON', '{"errors": [', 'is not a JSON object'],
		[
			'a report without --time',
			JSON.stringify({ results: [], errors: [] }),
			'Run semgrep with --time',
		],
		[
			'a report without errors',
			JSON.stringify({ time: { fixpoint_timeouts: [] } }),
			'Run semgrep with --time',
		],
	])('fails closed on %s', async (_label, contents, message) => {
		const result = await check(contents);
		expect(result.code).toBe(2);
		expect(result.stdout).toContain('::error title=Semgrep report unusable::');
		expect(result.stdout).toContain(message);
		expect(result.summary).toContain('**Report unusable:**');
	});

	it('is wired to a single-job scan that writes the report it reads', async () => {
		const workflow = await readFile(
			join(REPOSITORY_ROOT, '.github/workflows/security.yml'),
			'utf8'
		);
		const scan = workflow.slice(workflow.indexOf('- name: Semgrep scan'));
		const scanStep = scan.slice(0, scan.indexOf('- name:', 1));
		expect(scanStep).toMatch(/^\s+--jobs 1$/m);
		expect(scanStep).toMatch(/^\s+--time --json-output "\$RUNNER_TEMP\/semgrep\.json"$/m);
		const checkStep = scan.slice(scan.indexOf('- name: Check Semgrep coverage'));
		expect(checkStep).toContain('if: ${{ !cancelled() }}');
		expect(checkStep).toContain(
			'run: bash scripts/check-semgrep-timeouts.sh "$RUNNER_TEMP/semgrep.json"'
		);
	});
});
