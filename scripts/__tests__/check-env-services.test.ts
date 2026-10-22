/**
 * The Node services run the env gate (`apps/api/scripts/check-env.sh`) from
 * their `lint` script, each with its source root and the files allowed to read
 * the environment. These cases take those arguments from the real package.json
 * and run the real gate twice per service: on the service's source, which must
 * be clean, and on a throwaway copy of its allowed files plus one injected
 * stray read, which must fail. A lint script that drops the gate, or an
 * allowlist that grows to cover the whole tree, fails here.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SERVICES = ['mta', 'imap', 'code-worker', 'updater', 'mail-sync'];
const INVOCATION = /\bbash \.\.\/api\/scripts\/check-env\.sh ((?:[\w./-]+ ?)+)/;

const roots: string[] = [];

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** The `[root, ...allowed]` arguments the service's lint script passes. */
function gateArguments(service: string): string[] {
	const manifest = JSON.parse(
		readFileSync(join(REPOSITORY_ROOT, 'apps', service, 'package.json'), 'utf8')
	) as { scripts?: Record<string, string> };
	const match = INVOCATION.exec(manifest.scripts?.['lint'] ?? '');
	if (!match) throw new Error(`apps/${service} lint does not run check-env.sh`);
	return match[1]!.trim().split(/\s+/);
}

function runGate(args: string[], cwd: string): number {
	try {
		execFileSync('bash', [join(REPOSITORY_ROOT, 'apps/api/scripts/check-env.sh'), ...args], {
			cwd,
			stdio: 'pipe',
		});
		return 0;
	} catch (error) {
		const status = (error as { status?: number }).status;
		return typeof status === 'number' ? status : 1;
	}
}

describe.each(SERVICES)('apps/%s', (service) => {
	const serviceDirectory = join(REPOSITORY_ROOT, 'apps', service);

	it('allows only its config module, plus at most a logger', () => {
		const [, ...allowed] = gateArguments(service);
		expect(allowed).toContain('config.ts');
		expect(
			allowed.filter((path) => path !== 'config.ts').every((path) => /logger\.ts$/.test(path))
		).toBe(true);
	});

	it('reads the environment only in the allowed files', () => {
		expect(runGate(gateArguments(service), serviceDirectory)).toBe(0);
	});

	it('fails a read injected anywhere else', () => {
		const [root, ...allowed] = gateArguments(service);
		const copy = mkdtempSync(join(tmpdir(), `owlat-env-gate-${service}-`));
		roots.push(copy);
		for (const path of allowed) {
			const target = join(copy, root!, path);
			mkdirSync(dirname(target), { recursive: true });
			copyFileSync(join(serviceDirectory, root!, path), target);
		}
		expect(runGate([root!, ...allowed], copy)).toBe(0);

		writeFileSync(join(copy, root!, 'injected.ts'), "export const x = process.env['X'];\n");
		expect(runGate([root!, ...allowed], copy)).toBe(1);
	});
});
