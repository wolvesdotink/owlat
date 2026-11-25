/**
 * `bun run ci:bundle` stands in for CI's web bundle budget on a contributor's
 * machine, so its steps must stay the ones the web image and the workflow run,
 * and its memory guard must stop it before the build starts.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	availableBytes,
	BUILD_HEAP_MIB,
	BUILD_STEPS,
	CHECK_STEPS,
	MIN_AVAILABLE_ENV,
	MIN_AVAILABLE_GIB,
	memoryRefusal,
	minAvailableGiB,
	vmStatAvailableBytes,
} from '../ci/bundle';

const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = resolve(ROOT, 'scripts/ci/bundle.ts');
const GIB = 1024 ** 3;

describe('ci:bundle steps', () => {
	it('builds the way the web Dockerfile does', () => {
		const dockerfile = readFileSync(resolve(ROOT, 'apps/web/Dockerfile'), 'utf8');
		expect(dockerfile).toContain(`ENV NODE_OPTIONS=--max-old-space-size=${BUILD_HEAP_MIB}`);
		expect(dockerfile).toContain('ARG NITRO_PRESET=node-server');
		const runs = [...dockerfile.matchAll(/^RUN cd (\S+) && (.+)$/gm)].map(
			([, cwd, command]) => `${cwd}: ${command}`
		);
		expect(runs).toEqual(
			BUILD_STEPS.filter((step) => step.cwd !== '.').map(
				(step) => `${step.cwd}: ${step.command} ${step.args.join(' ')}`
			)
		);
		expect(dockerfile).toContain('RUN bun run --cwd packages/provider-kit build');
		expect(dockerfile).toContain('RUN bun run --cwd packages/plugin-kit build');
		const rootScripts = (
			JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
				scripts: Record<string, string>;
			}
		).scripts;
		expect(rootScripts['plugins:prepare']).toBe(
			'bun run --cwd packages/provider-kit build && bun run --cwd packages/plugin-kit build'
		);
		expect(rootScripts['ci:bundle']).toBe('bun scripts/ci/bundle.ts');
	});

	it('runs the blocking budget scripts of the test workflow', () => {
		const workflow = readFileSync(resolve(ROOT, '.github/workflows/test.yml'), 'utf8');
		for (const step of CHECK_STEPS) {
			expect(workflow).toContain(`${step.command} ${step.args[0]} "$RUNNER_TEMP/web-output"`);
		}
	});
});

describe('ci:bundle memory guard', () => {
	it('reads MemAvailable, and the fallback where there is no /proc/meminfo', () => {
		const meminfo = 'MemTotal:       32000000 kB\nMemAvailable:    6291456 kB\n';
		expect(availableBytes(meminfo, 1)).toBe(6 * GIB);
		expect(availableBytes(undefined, 1234)).toBe(1234);
	});

	// `vm_stat` on an Apple-silicon Mac (16 KiB pages). Its "Pages free" leaves
	// out the speculative pages, which the kernel's free count (os.freemem())
	// includes.
	const VM_STAT = [
		'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
		'Pages free:                                4000.',
		'Pages active:                            300000.',
		'Pages inactive:                          250000.',
		'Pages speculative:                         6000.',
		'Pages throttled:                              0.',
		'Pages wired down:                        150000.',
		'Pages purgeable:                          20000.',
		'"Translation faults":                 123456789.',
		'Pages copy-on-write:                    1234567.',
		'File-backed pages:                       200000.',
		'Anonymous pages:                         356000.',
		'Pages stored in compressor:              300000.',
		'Pages occupied by compressor:            100000.',
		'',
	].join('\n');

	it('counts free, speculative and inactive pages from vm_stat on macOS', () => {
		expect(vmStatAvailableBytes(VM_STAT)).toBe((4000 + 6000 + 250000) * 16384);
	});

	it('reads the page size vm_stat names, and nothing from output it cannot read', () => {
		const intel = VM_STAT.replace('page size of 16384 bytes', 'page size of 4096 bytes');
		expect(vmStatAvailableBytes(intel)).toBe((4000 + 6000 + 250000) * 4096);
		expect(vmStatAvailableBytes(undefined)).toBeUndefined();
		expect(vmStatAvailableBytes('')).toBeUndefined();
		expect(vmStatAvailableBytes(VM_STAT.replace(/^Pages inactive:.*$/m, ''))).toBeUndefined();
		expect(vmStatAvailableBytes(VM_STAT.replace(/^Mach Virtual.*$/m, ''))).toBeUndefined();
	});

	it('takes the threshold from the environment, and rejects one it cannot read', () => {
		expect(minAvailableGiB({})).toBe(MIN_AVAILABLE_GIB);
		expect(minAvailableGiB({ [MIN_AVAILABLE_ENV]: '0' })).toBe(0);
		expect(minAvailableGiB({ [MIN_AVAILABLE_ENV]: '2.5' })).toBe(2.5);
		expect(() => minAvailableGiB({ [MIN_AVAILABLE_ENV]: 'lots' })).toThrow(MIN_AVAILABLE_ENV);
	});

	it('refuses below the threshold with a sentence, and lets the run start at it', () => {
		expect(memoryRefusal(5 * GIB, 5)).toBeUndefined();
		expect(memoryRefusal(3.25 * GIB, 5)).toMatch(
			/^ci:bundle: only 3\.3 GiB of memory is available and the production web build needs 5 GiB, so it did not start\./
		);
	});

	it('stops before the first build step when the guard trips', () => {
		const result = spawnSync('bun', [SCRIPT], {
			cwd: ROOT,
			encoding: 'utf8',
			env: { ...process.env, [MIN_AVAILABLE_ENV]: '1000000' },
		});
		expect(result.status).toBe(2);
		expect(result.stderr).toContain(
			'the production web build needs 1000000 GiB, so it did not start'
		);
		expect(result.stdout).not.toContain('== ci:bundle:');
	});
});
