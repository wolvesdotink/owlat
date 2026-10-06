/**
 * `scripts/check-semgrep-timeouts.sh` prints text from the Semgrep report and
 * Semgrep's own output into the job log. The runner reads workflow commands
 * from that log (`::cmd::` after leading whitespace, `##[cmd]` anywhere), so
 * the script prints report text only between `::stop-commands::<token>` and
 * `::<token>::`, prefixes each such line, and rewrites `##[`. These cases run
 * the real script and check its output against a model of the runner's
 * command processing.
 */

import { afterAll, describe, expect, it } from 'vitest';
import {
	RULE_PARSE_ERROR,
	check,
	cleanup,
	fixpointTimeout,
	report,
	runnerCommands,
	scan,
	suspendedBlocks,
} from './semgrepTimeouts.testlib';

afterAll(cleanup);

const HOSTILE = report({
	timeouts: [
		fixpointTimeout('::warning::injected.ts', 3, 0, 1, 'rule.a'),
		fixpointTimeout('x.ts\n::error::from-path', 4, 2, 1, 'rule.b'),
	],
	errors: [
		{ ...RULE_PARSE_ERROR, message: 'parse error ##[add-mask]HIDE_ME here' },
		{
			...RULE_PARSE_ERROR,
			rule_id: 'r',
			message: '::semgrep-coverage-guess::\n::warning::after-fake-resume',
		},
		{ ...RULE_PARSE_ERROR, level: 'warn', message: '  ::stop-commands::evil\n::notice::x' },
	],
});

describe('check-semgrep-timeouts workflow commands', () => {
	it('acts only on its own commands for a hostile report', async () => {
		const result = await check(HOSTILE);
		expect(result.code).toBe(1);
		expect(runnerCommands(result.stdout)).toEqual([
			'::group::Semgrep errors and warnings (2 error(s), 1 warning(s))',
			'::endgroup::',
			'::error file=%3A%3Awarning%3A%3Ainjected.ts,line=3,title=Semgrep fixpoint timeout::Taint analysis of this function timed out for 1 rule(s) (first: rule.a), so their findings here can be missing.',
			'::error file=x.ts%0A%3A%3Aerror%3A%3Afrom-path,line=4,title=Semgrep fixpoint timeout::Taint analysis of this function timed out for 1 rule(s) (first: rule.b), so their findings here can be missing.',
			'::warning title=Semgrep Rule parse error::webhook-signature-presence-only: parse error ##[add-mask]HIDE_ME here',
			'::warning title=Semgrep Rule parse error::r: ::semgrep-coverage-guess::%0A::warning::after-fake-resume',
		]);
	});

	it('prints every report-derived line inside a stop/resume pair, prefixed and without ##[', async () => {
		const result = await check(HOSTILE);
		const { inside, outside, tokens } = suspendedBlocks(result.stdout);
		expect(tokens).toHaveLength(2);
		expect(new Set(tokens).size).toBe(1);
		expect(inside.length).toBe(5);
		for (const line of inside) {
			expect(line).toMatch(/^semgrep-coverage: /);
			expect(line).not.toContain('##[');
		}
		expect(inside).toContain(
			'semgrep-coverage: ::warning::injected.ts:3  function, rules: 1, first: rule.a'
		);
		expect(inside).toContain(
			'semgrep-coverage: [error] Rule parse error  webhook-signature-presence-only  parse error ##(add-mask]HIDE_ME here'
		);
		// Nothing from the report outside the pairs except the escaped annotations.
		for (const line of outside) {
			expect(line.startsWith('semgrep-coverage: ')).toBe(false);
			if (line.includes('injected') || line.includes('HIDE_') || line.includes('fake-resume')) {
				expect(line).toMatch(/^::(error|warning) /);
			}
		}
		// Annotations come after the last resume.
		const lines = result.stdout.split('\n');
		const lastResume = lines.lastIndexOf(`::${tokens[0]}::`);
		const firstAnnotation = lines.findIndex((line) => /^::(error|warning) /.test(line));
		expect(firstAnnotation).toBeGreaterThan(lastResume);
	});

	it('uses a fresh random token on every run, never one from the report', async () => {
		const first = suspendedBlocks((await check(HOSTILE)).stdout).tokens[0];
		const second = suspendedBlocks((await check(HOSTILE)).stdout).tokens[0];
		expect(first).toMatch(/^semgrep-coverage-[0-9a-f]{32}$/);
		expect(second).toMatch(/^semgrep-coverage-[0-9a-f]{32}$/);
		expect(first).not.toBe(second);
		expect(HOSTILE).not.toContain(first);
	});

	it("suspends commands while Semgrep's own output prints", async () => {
		const result = await scan([
			{
				report: report(),
				stdout: '::warning::from-semgrep\n  ##[add-mask]HIDE_SEMGREP\n::error file=a.ts::x\n',
			},
		]);
		expect(result.code).toBe(0);
		expect(runnerCommands(result.stdout)).toEqual([]);
		expect(suspendedBlocks(result.stdout).inside).toEqual([
			'::warning::from-semgrep',
			'  ##[add-mask]HIDE_SEMGREP',
			'::error file=a.ts::x',
		]);
	});

	it('keeps its own commands working after Semgrep output and an unusable report', async () => {
		const result = await scan([{ report: null, stdout: '::warning::x\n' }]);
		expect(result.code).toBe(2);
		expect(runnerCommands(result.stdout)).toEqual([
			expect.stringMatching(/^::error title=Semgrep report unusable::/),
		]);
	});
});
