/**
 * The shared ratchet runner's own gate.
 *
 * scripts/ratchet.sh is now the single comparison behind seven baselines, so a
 * mistake in it is a mistake in all seven at once — and every mistake a ratchet
 * can make is silent: a runner that ignores a new entry, or that quietly treats
 * a failed generator as "everything got fixed", is indistinguishable from
 * `exit 0`. Each rule is therefore proved by a pair, green beside red.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const RATCHET = resolve(import.meta.dirname, '../ratchet.sh');

const sandboxes: string[] = [];
afterEach(() => {
	while (sandboxes.length > 0) {
		const dir = sandboxes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

type Result = { status: number; stdout: string; stderr: string };

/**
 * Run the runner in a throwaway directory: `baseline` is written to
 * baseline.txt (unless null), and the generator is a shell command that echoes
 * `current` — or, when `generatorExit` is set, fails with that status instead.
 */
function ratchet(options: {
	current: string[];
	baseline: string[] | null;
	flags?: string[];
	generatorExit?: number;
}): Result & { dir: string; baselineText: string } {
	const dir = mkdtempSync(join(tmpdir(), 'owlat-ratchet-'));
	sandboxes.push(dir);
	if (options.baseline !== null) {
		writeFileSync(join(dir, 'baseline.txt'), `${options.baseline.join('\n')}\n`);
	}
	const generator =
		options.generatorExit === undefined
			? `printf '%s\\n' ${options.current.map((line) => `'${line}'`).join(' ')}`
			: `echo 'generator broke' >&2; exit ${options.generatorExit}`;
	const run = spawnSync(
		'bash',
		[
			RATCHET,
			'--baseline',
			'baseline.txt',
			'--seed',
			'bash scripts/check-thing.sh --write-baseline',
			'--ok',
			'no new things',
			'--new-header',
			'FAIL: {n} new thing(s) not in {baseline}:',
			'--new-advice',
			'Fix the thing.',
			'--stale-header',
			'FAIL: {n} stale entr(y/ies) in {baseline} (thing fixed):',
			...(options.flags ?? []),
			'--',
			'bash',
			'-c',
			generator,
		],
		{ cwd: dir, encoding: 'utf8' }
	);
	return {
		status: run.status ?? -1,
		stdout: run.stdout,
		stderr: run.stderr,
		dir,
		get baselineText() {
			return readFileSync(join(dir, 'baseline.txt'), 'utf8');
		},
	};
}

describe('the ratchet runner, comparing against a baseline', () => {
	it('passes when the generator reports exactly the frozen set', () => {
		const run = ratchet({ current: ['a:one', 'b:two'], baseline: ['a:one', 'b:two'] });
		expect(run.stdout).toBe('ok:   no new things (2 baseline entries remain)\n');
		expect(run.status).toBe(0);
	});

	it('fails an entry that is not in the baseline, and names it', () => {
		const run = ratchet({ current: ['a:one', 'c:three'], baseline: ['a:one'] });
		expect(run.stdout).toContain('FAIL: 1 new thing(s) not in baseline.txt:');
		expect(run.stdout).toContain('c:three');
		expect(run.stdout).toContain('Fix the thing.');
		expect(run.status).toBe(1);
	});

	it('fails a baseline entry the generator no longer reports, so debt only falls', () => {
		const run = ratchet({ current: ['a:one'], baseline: ['a:one', 'gone:two'] });
		expect(run.stdout).toContain('FAIL: 1 stale entr(y/ies) in baseline.txt (thing fixed):');
		expect(run.stdout).toContain('gone:two');
		expect(run.status).toBe(1);
	});

	it('reports both directions in one run', () => {
		const run = ratchet({ current: ['new:one'], baseline: ['gone:two'] });
		expect(run.stdout).toContain('new:one');
		expect(run.stdout).toContain('gone:two');
		expect(run.status).toBe(1);
	});

	it('counts repeats, so the same violation on a second site is still caught', () => {
		const twice = ratchet({ current: ['a:dup', 'a:dup'], baseline: ['a:dup'] });
		expect(twice.status).toBe(1);
		const once = ratchet({ current: ['a:dup'], baseline: ['a:dup'] });
		expect(once.status).toBe(0);
	});

	it('reads a baseline that is out of order, or commented, or blank-padded', () => {
		const run = ratchet({
			current: ['a:one', 'b:two'],
			baseline: ['# frozen debt', '', 'b:two', 'a:one'],
		});
		expect(run.stdout).toBe('ok:   no new things (2 baseline entries remain)\n');
		expect(run.status).toBe(0);
	});
});

describe('the ratchet runner, when it cannot compare', () => {
	it('fails with the reseed command when the baseline is missing', () => {
		const run = ratchet({ current: ['a:one'], baseline: null });
		expect(run.stderr).toContain('FAIL: baseline.txt missing');
		expect(run.stderr).toContain('bash scripts/check-thing.sh --write-baseline');
		expect(run.status).toBe(1);
	});

	it('propagates a failed generator instead of reporting an empty set as clean', () => {
		const run = ratchet({ current: [], baseline: ['a:one'], generatorExit: 3 });
		expect(run.status).toBe(3);
		expect(run.stdout).not.toContain('stale');
	});
});

describe('the ratchet runner, reseeding', () => {
	it('writes the current set and keeps the baseline’s comment header', () => {
		const run = ratchet({
			current: ['b:two', 'a:one'],
			baseline: ['# frozen debt', 'old:entry'],
			flags: ['--write-baseline'],
		});
		expect(run.status).toBe(0);
		expect(run.baselineText).toBe('# frozen debt\na:one\nb:two\n');
	});

	it('seeds a baseline that does not exist yet', () => {
		const run = ratchet({ current: ['a:one'], baseline: null, flags: ['--write-baseline'] });
		expect(run.status).toBe(0);
		expect(run.baselineText).toBe('a:one\n');
	});
});

describe('the ratchet runner, where it writes', () => {
	it('sends failures to stdout by default and to stderr on request', () => {
		const loud = ratchet({ current: ['c:three'], baseline: [] });
		expect(loud.stdout).toContain('c:three');
		expect(loud.stderr).toBe('');

		const quiet = ratchet({ current: ['c:three'], baseline: [], flags: ['--stderr'] });
		expect(quiet.stderr).toContain('c:three');
		expect(quiet.stdout).toBe('');
	});
});
