/**
 * Conformance for the Semgrep coverage check (`scripts/check-semgrep-timeouts.sh`)
 * on a single report.
 *
 * The cases run the REAL script against Semgrep `--time --json-output`
 * reports shaped like Semgrep 1.178's and pin what it prints, what it writes
 * to the job summary and how it exits: 1 on a fixpoint timeout, 2 when the
 * report cannot be checked, 0 otherwise. `--scan` mode is covered in
 * check-semgrep-timeouts.scan.test.ts.
 */

import { afterAll, describe, expect, it } from 'vitest';
import {
	PARTIAL_PARSING,
	RULE_PARSE_ERROR,
	check,
	cleanup,
	fixpointTimeout,
	report,
	runnerCommands as commands,
} from './semgrepTimeouts.testlib';

afterAll(cleanup);

const REACT_RULE =
	'typescript.react.security.audit.react-unsanitized-method.react-unsanitized-method';
const RAW_HTML_RULE = 'javascript.express.security.injection.raw-html-format.raw-html-format';

describe('check-semgrep-timeouts', () => {
	it('passes a clean report and writes zero counts to the summary', async () => {
		const result = await check(report());
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('0 fixpoint timeout(s), 0 error(s), 0 warning(s)');
		expect(commands(result.stdout)).toEqual([]);
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
						REACT_RULE
					),
					fixpointTimeout('apps/api/convex/contacts/import.ts', 1, 0, 2, RAW_HTML_RULE),
				],
			})
		);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain('2 fixpoint timeout(s)');
		expect(commands(result.stdout)).toEqual([
			`::error file=apps/api/convex/agent/steps/context_retrieval/index.ts,line=91,title=Semgrep fixpoint timeout::Taint analysis of this function timed out for 1 rule(s) (first: ${REACT_RULE}), so their findings here can be missing.`,
			`::error file=apps/api/convex/contacts/import.ts,line=1,title=Semgrep fixpoint timeout::Taint analysis of this top-level code timed out for 2 rule(s) (first: ${RAW_HTML_RULE}), so their findings here can be missing.`,
		]);
		expect(result.summary).toContain('| Fixpoint timeouts | 2 |');
		expect(result.summary).toContain(
			`| apps/api/convex/agent/steps/context_retrieval/index.ts:91 | function | 1 | ${REACT_RULE} |`
		);
		expect(result.summary).toContain(
			`| apps/api/convex/contacts/import.ts:1 | top-level code | 2 | ${RAW_HTML_RULE} |`
		);
	});

	it('reports errors and warnings without failing, annotating only error-level entries', async () => {
		const result = await check(report({ errors: [RULE_PARSE_ERROR, PARTIAL_PARSING] }));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('0 fixpoint timeout(s), 1 error(s), 1 warning(s)');
		expect(result.stdout).toContain(
			"semgrep-coverage: [warn] PartialParsing  apps/api/convex/mail/outboundCron.ts  Syntax error at line apps/api/convex/mail/outboundCron.ts:63: `import('x')` was unexpected\n"
		);
		expect(commands(result.stdout)).toEqual([
			'::group::Semgrep errors and warnings (1 error(s), 1 warning(s))',
			'::endgroup::',
			'::warning title=Semgrep Rule parse error::webhook-signature-presence-only: Rule parse error in rule webhook-signature-presence-only:%0A Invalid pattern for TypeScript: Stdlib.Parsing.Parse_error%0A----- pattern -----%0A$X = $FN(...) {%0A}%0A',
		]);
		expect(result.summary).toContain('| Errors | 1 |');
		expect(result.summary).toContain('| Warnings | 1 |');
		expect(result.summary).toContain(
			"| warn | PartialParsing | apps/api/convex/mail/outboundCron.ts | Syntax error at line apps/api/convex/mail/outboundCron.ts:63: 'import('x')' was unexpected |"
		);
	});

	it('escapes annotation properties from the raw path: %, CR, LF, comma, colon; tab and backslash stay', async () => {
		const path = 'apps/a%b\r\nc\td\\e,f:g.ts';
		const result = await check(report({ timeouts: [fixpointTimeout(path, 7, 2, 1, 'rule%x')] }));
		expect(result.code).toBe(1);
		expect(commands(result.stdout)).toEqual([
			'::error file=apps/a%25b%0D%0Ac\td\\e%2Cf%3Ag.ts,line=7,title=Semgrep fixpoint timeout::Taint analysis of this function timed out for 1 rule(s) (first: rule%25x), so their findings here can be missing.',
		]);
		// The log line and the summary row stay on one line.
		expect(result.stdout).toContain(
			'semgrep-coverage: apps/a%b c d\\e,f:g.ts:7  function, rules: 1, first: rule%x\n'
		);
		expect(result.summary).toContain('| apps/a%b c d\\e,f:g.ts:7 | function | 1 | rule%x |');
	});

	it('keeps pipes and HTML out of the summary table', async () => {
		const result = await check(
			report({
				timeouts: [fixpointTimeout('apps/a|b.ts', 7, 2, 1, 'rule.with|pipe')],
				errors: [{ ...PARTIAL_PARSING, message: 'Syntax error: `/<!--|<(script)/g` & more' }],
			})
		);
		expect(result.summary).toContain('| apps/a\\|b.ts:7 | function | 1 | rule.with\\|pipe |');
		expect(result.summary).toContain("Syntax error: '/&lt;!--\\|&lt;(script)/g' &amp; more |");
		expect(result.summary).not.toContain('<!--');
	});

	it('handles entries with unexpected types instead of failing on them', async () => {
		const result = await check(
			report({
				timeouts: [
					{ message: 42, location: 'nowhere' },
					42,
					{
						...fixpointTimeout('apps/x.ts', 3, 0, 1, 'rule'),
						location: { path: 9, start: { line: '3' } },
					},
				],
				errors: [{ level: 'error', type: 7, message: 42, path: ['a'] }, 'oops'],
			})
		);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain('3 fixpoint timeout(s), 2 error(s), 0 warning(s)');
		expect(commands(result.stdout)).toEqual([
			'::group::Semgrep errors and warnings (2 error(s), 0 warning(s))',
			'::endgroup::',
			'::error title=Semgrep fixpoint timeout::Taint analysis of this function timed out for ? rule(s) (first: ?), so their findings here can be missing.',
			'::error title=Semgrep fixpoint timeout::Taint analysis of this function timed out for ? rule(s) (first: ?), so their findings here can be missing.',
			'::error file=9,title=Semgrep fixpoint timeout::Taint analysis of this function timed out for 1 rule(s) (first: rule), so their findings here can be missing.',
			'::warning title=Semgrep 7::["a"]: 42',
			'::warning title=Semgrep ?::-: ',
		]);
		expect(result.summary).toContain('| Fixpoint timeouts | 3 |');
	});

	it('works without a job summary', async () => {
		const result = await check(report(), { summary: false });
		expect(result.code).toBe(0);
		expect(result.summary).toBe('');
	});

	it.each([
		['a missing report', null, 'is missing or empty'],
		['an empty report', '', 'is missing or empty'],
		['invalid JSON', '{"errors": [', 'is not a single JSON object'],
		['two concatenated reports', report() + report(), 'is not a single JSON object'],
		['a JSON array', '[]', 'is not a single JSON object'],
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
		['a non-object time', JSON.stringify({ time: 'x', errors: [] }), 'Run semgrep with --time'],
	])('fails closed on %s', async (_label, contents, message) => {
		const result = await check(contents);
		expect(result.code).toBe(2);
		expect(commands(result.stdout)).toEqual([
			expect.stringMatching(/^::error title=Semgrep report unusable::/),
		]);
		expect(result.stdout).toContain(message);
		expect(result.summary).toContain('**Report unusable:**');
	});
});
