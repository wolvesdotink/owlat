import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
it('collects shards without floors but fails merged coverage on a per-path regression', () => {
	const root = resolve('.'),
		directory = mkdtempSync(join(tmpdir(), 'owlat-coverage-'));
	try {
		symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
		mkdirSync(join(directory, 'src'));
		writeFileSync(
			join(directory, 'src/target.ts'),
			'export function choose(flag: boolean) {\n if(flag) { return 1; }\n return 2;\n}\n'
		);
		writeFileSync(join(directory, 'src/other.ts'), 'export const value = 1;\n');
		writeFileSync(
			join(directory, 'target.test.ts'),
			"import {it,expect} from 'vitest';import {choose} from './src/target';it('true only',()=>expect(choose(true)).toBe(1));"
		);
		writeFileSync(
			join(directory, 'other.test.ts'),
			"import {it,expect} from 'vitest';import {value} from './src/other';it('other',()=>expect(value).toBe(1));"
		);
		writeFileSync(
			join(directory, 'vitest.config.mts'),
			`import {packageCoverage} from ${JSON.stringify(join(root, 'vitest.shared.ts'))};export default {test:{include:['*.test.ts'],coverage:packageCoverage({include:['src/*.ts'],thresholds:{'src/target.ts':{lines:100}}})}};`
		);
		const cli = join(root, 'node_modules/vitest/vitest.mjs');
		for (const shard of [1, 2]) {
			const run = spawnSync(
				process.execPath,
				[cli, 'run', '--coverage', '--maxWorkers=1', '--reporter=blob', `--shard=${shard}/2`],
				{
					cwd: directory,
					encoding: 'utf8',
					env: { ...process.env, OWLAT_COVERAGE_COLLECT_ONLY: '1' },
					timeout: 60_000,
				}
			);
			expect(run.status, run.stdout + run.stderr).toBe(0);
		}
		const env = { ...process.env };
		delete env['OWLAT_COVERAGE_COLLECT_ONLY'];
		const merge = spawnSync(process.execPath, [cli, '--merge-reports', '--coverage'], {
			cwd: directory,
			encoding: 'utf8',
			env,
			timeout: 60_000,
		});
		expect(merge.status, merge.stdout + merge.stderr).toBe(1);
		expect(merge.stdout + merge.stderr).toContain('src/target.ts');
		expect(merge.stdout + merge.stderr).toMatch(/threshold/i);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 120_000);
