/**
 * Conformance for the UTC-day ratchet (`apps/api/scripts/check-utc-day.sh`).
 *
 * The cases run the REAL script's `--generate` half against throwaway
 * `apps/api` trees and pin what it reports: a hand-rolled day start
 * (`setUTCHours(0, 0, 0, 0)`) or day key (`toISOString().slice(0, 10)`,
 * `.split('T')[0]`) under `convex/`, outside `lib/clock.ts`, tests and
 * generated code. Prose that names a spelling is not code and is not reported.
 */

import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const run = promisify(execFile);

const GATE = 'apps/api/scripts/check-utc-day.sh';

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots.length = 0;
});

/** `file:spelling` entries the gate reports for a throwaway tree holding `files`. */
async function violations(files: Record<string, string>): Promise<string[]> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-utc-day-gate-'));
	roots.push(root);

	await mkdir(join(root, 'apps/api/convex'), { recursive: true });
	for (const [path, contents] of Object.entries(files)) {
		const target = join(root, 'apps/api', path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, contents, 'utf8');
	}
	await mkdir(join(root, 'apps/api/scripts'), { recursive: true });
	await copyFile(join(REPOSITORY_ROOT, GATE), join(root, GATE));

	const { stdout } = await run('bash', [GATE, '--generate'], { cwd: root });
	return stdout.split('\n').filter((line) => line.length > 0);
}

describe('convex UTC-day ratchet', () => {
	it('reports each hand-rolled day spelling by file', async () => {
		expect(
			await violations({
				'convex/lib/caps.ts': 'const start = new Date(now).setUTCHours(0, 0, 0, 0);\n',
				'convex/analytics/daily.ts': 'const key = new Date(at).toISOString().slice(0, 10);\n',
				'convex/contacts/growth.ts': [
					"const a = new Date(at).toISOString().split('T')[0];",
					'const b = new Date(at).toISOString().split("T")[0]!;',
					'',
				].join('\n'),
			})
		).toEqual([
			'convex/analytics/daily.ts:toISOString().slice(0, 10)',
			"convex/contacts/growth.ts:.split('T')[0]",
			"convex/contacts/growth.ts:.split('T')[0]",
			'convex/lib/caps.ts:setUTCHours(0, 0, 0, 0)',
		]);
	});

	it('exempts lib/clock.ts, tests and generated code', async () => {
		const spelled = 'const key = new Date(at).toISOString().slice(0, 10);\n';
		expect(
			await violations({
				'convex/lib/clock.ts': spelled,
				'convex/lib/__tests__/caps.test.ts': spelled,
				'convex/analytics/daily.test.ts': spelled,
				'convex/_generated/api.ts': spelled,
			})
		).toEqual([]);
	});

	it('ignores prose that names a spelling, and code that imports the day', async () => {
		expect(
			await violations({
				'convex/lib/sendDailyStats.ts': [
					'// never setUTCHours(0, 0, 0, 0) by hand',
					' * nor toISOString().slice(0, 10)',
					"import { utcDayKey } from './clock';",
					'const key = utcDayKey(at);',
					'',
				].join('\n'),
			})
		).toEqual([]);
	});

	it('does not report a timestamp slice that is not a day', async () => {
		expect(
			await violations({
				'convex/lib/stamp.ts': 'const minute = new Date(at).toISOString().slice(0, 16);\n',
			})
		).toEqual([]);
	});
});
