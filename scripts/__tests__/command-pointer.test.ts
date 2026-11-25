/**
 * `ox:fmt`, `dev` and `dev:api` at the root refuse and name the command that
 * works. The cases pin the wiring in package.json, the exit code a chained
 * command stops on, and that each pointer names its replacement.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POINTERS, pointerFor } from '../command-pointer';

const root = join(import.meta.dirname, '..', '..');
const scripts = (
	JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
		scripts: Record<string, string>;
	}
).scripts;

describe('command-pointer', () => {
	it.each(Object.keys(POINTERS))('the root %s script runs its pointer', (name) => {
		expect(scripts[name]).toBe(`bun scripts/command-pointer.ts ${name}`);
	});

	it.each([
		['ox:fmt', './node_modules/.bin/oxfmt --config oxfmtrc.json <paths>'],
		['dev', 'bun run dev:stack'],
		['dev:api', 'bun run dev:stack'],
	])('%s names %s', (name, replacement) => {
		expect(pointerFor(name)).toContain(replacement);
	});

	it('prints the pointer on stderr and exits 1', () => {
		const result = spawnSync('bun', ['scripts/command-pointer.ts', 'ox:fmt'], {
			cwd: root,
			encoding: 'utf8',
		});
		expect(result.status).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toBe(`${pointerFor('ox:fmt')}\n`);
	});

	it('is never what the legacy setup wizard tells a developer to run next', () => {
		const wizard = readFileSync(join(root, 'scripts/setup.sh'), 'utf8');
		const summary = /^show_summary\(\) \{\n[\s\S]*?\n\}\n/m.exec(wizard)![0];
		const named = [...summary.matchAll(/bun run (?!--)([\w:-]+)/g)].map(([, name]) => name!);
		expect(named).toContain('dev:stack');
		for (const name of named) {
			expect(Object.keys(scripts), name).toContain(name);
			expect(Object.keys(POINTERS), name).not.toContain(name);
		}
	});
});
