/**
 * The TypeScript under scripts/ backs up, restores and gates the release, but
 * scripts/ is not a workspace: `turbo typecheck` never reached it and vitest
 * strips types without checking them, so type errors piled up in the tests
 * unnoticed. scripts/tsconfig.json covers the directory and the root
 * `typecheck:scripts` entry runs it from both CI typecheck paths. These cases
 * pin that wiring, so a file left out of the program or a gate that stops
 * calling it fails here.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function read(relativePath: string): string {
	return readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8');
}

const rootScripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> })
	.scripts;

describe('scripts/ typecheck', () => {
	it('puts every tracked TypeScript file under scripts/ in the program', () => {
		const tracked = execFileSync('git', ['ls-files', 'scripts/'], {
			cwd: REPOSITORY_ROOT,
			encoding: 'utf8',
		})
			.split('\n')
			.filter((file) => file.endsWith('.ts'));
		const listed = new Set(
			execFileSync(
				join(REPOSITORY_ROOT, 'node_modules/.bin/tsc'),
				['-p', 'scripts', '--listFilesOnly'],
				{ cwd: REPOSITORY_ROOT, encoding: 'utf8' }
			)
				.split('\n')
				.filter(Boolean)
				.map((file) => relative(REPOSITORY_ROOT, file))
		);

		expect(tracked).toContain('scripts/__tests__/restore.test.ts');
		expect(tracked.filter((file) => !listed.has(file))).toEqual([]);
	});

	it('is a root script that runs tsc on scripts/', () => {
		expect(rootScripts['typecheck:scripts']).toBe('tsc -p scripts');
	});

	it('runs from the typecheck entries, the PR lint job and the release verify gate', () => {
		expect(rootScripts['typecheck']).toContain('bun run typecheck:scripts');
		expect(rootScripts['ci:typecheck']).toContain('bun run typecheck:scripts');
		expect(read('.github/workflows/test.yml')).toContain('run: bun run ci:typecheck');

		const gate = read('scripts/ci-gate.sh');
		expect(gate).toMatch(/if \[\[ "\$1" == verify \]\]; then\n\tstep bun run typecheck:scripts\n/);
	});
});
