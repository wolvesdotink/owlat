/**
 * scripts/ci/gates.ts is the one list of root lint gates and plugin smokes:
 * scripts/ci-gate.sh runs every entry from it in CI and `ci:verify`, and
 * `bun run check:changed` runs the entries whose inputs a change touches.
 * These cases pin that wiring: a root `lint:*` script missing from the list,
 * a gate whose own scripts (with the scripts they run and the modules they
 * import) or baseline are not among its inputs, or a ci-gate.sh that stops
 * running the list in order fails here.
 */

import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	GATE_GLOBAL_INPUTS,
	PLUGIN_GRAPH_INPUTS,
	PLUGIN_SMOKES,
	ROOT_GATES,
	SCRIPTS_TYPECHECK_INPUTS,
	gateCommand,
	listCommands,
} from '../ci/gates';
import { gateSelected, matchesAny } from '../ci/selection';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string) => readFileSync(join(REPOSITORY_ROOT, path), 'utf8');
const rootScripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> })
	.scripts;
const gate = (name: string) => ROOT_GATES.find((entry) => entry.name === name)!;
const selects = (name: string, changed: string[], affected: string[] = []) =>
	gateSelected(gate(name), changed, new Set(affected), GATE_GLOBAL_INPUTS);
const isFile = (path: string) =>
	existsSync(join(REPOSITORY_ROOT, path)) && statSync(join(REPOSITORY_ROOT, path)).isFile();

/**
 * Every repo file a `lint:*` command reaches: the scripts it names, the
 * scripts those shell scripts run (comment lines skipped), and the relative
 * imports of the TypeScript ones, followed transitively. An edit to any of
 * them can change the gate's result, so each has to be one of its inputs.
 */
function gateScriptClosure(command: string): string[] {
	const queue = [...command.matchAll(/\bscripts\/[\w./-]+/g)].map((match) => match[0]);
	const seen = new Set<string>();
	while (queue.length > 0) {
		const file = queue.shift()!;
		if (seen.has(file)) continue;
		seen.add(file);
		if (!isFile(file)) continue;
		const source = read(file);
		if (file.endsWith('.sh')) {
			const code = source
				.split('\n')
				.filter((line) => !line.trimStart().startsWith('#'))
				.join('\n');
			for (const match of code.matchAll(/\bscripts\/[\w./-]+\.(?:sh|ts)\b/g))
				if (isFile(match[0])) queue.push(match[0]);
		} else if (file.endsWith('.ts')) {
			for (const match of source.matchAll(
				/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g
			)) {
				const base = posix.normalize(posix.join(posix.dirname(file), match[1]!));
				// Unresolvable specifiers are string literals in scanner fixtures.
				const resolved = [base, `${base}.ts`, `${base}/index.ts`].find(isFile);
				if (resolved) queue.push(resolved);
			}
		}
	}
	return [...seen];
}

describe('root gate manifest', () => {
	it('lists every root lint:* gate once, and only real ones', () => {
		const lintScripts = Object.keys(rootScripts)
			.filter((name) => name.startsWith('lint:') && name !== 'lint:fix')
			.map((name) => name.slice('lint:'.length))
			.sort();
		const names = ROOT_GATES.map((entry) => entry.name);
		expect(new Set(names).size).toBe(names.length);
		expect([...names].sort()).toEqual(lintScripts);
	});

	it("counts each gate's own scripts, the scripts they run or import, baselines and allowlists among its inputs", () => {
		for (const entry of ROOT_GATES) {
			const script = rootScripts[`lint:${entry.name}`]!;
			for (const file of gateScriptClosure(script))
				expect(matchesAny(file, entry.paths), `${entry.name}: ${file}`).toBe(true);
		}
		// The helpers the compose and desktop-invoke scanners import.
		expect(gateScriptClosure(rootScripts['lint:compose']!)).toEqual(
			expect.arrayContaining(['scripts/compose-schema-keys.ts', 'scripts/docker-socket-access.ts'])
		);
		expect(gateScriptClosure(rootScripts['lint:desktop-invoke']!)).toEqual(
			expect.arrayContaining(['scripts/desktop-invoke-scan.ts', 'scripts/desktop-invoke-vue.ts'])
		);
		expect(selects('compose', ['scripts/compose-schema-keys.ts'])).toBe(true);
		expect(selects('compose', ['scripts/docker-socket-access.ts'])).toBe(true);
		expect(selects('desktop-invoke', ['scripts/desktop-invoke-scan.ts'])).toBe(true);
		expect(selects('desktop-invoke', ['scripts/desktop-invoke-vue.ts'])).toBe(true);
		const dataFiles = readdirSync(join(REPOSITORY_ROOT, 'scripts')).filter((file) =>
			/baseline|allowlist|collisions/.test(file)
		);
		expect(dataFiles.length).toBeGreaterThan(5);
		for (const file of dataFiles)
			expect(
				ROOT_GATES.some((entry) => matchesAny(`scripts/${file}`, entry.paths)),
				file
			).toBe(true);
	});

	it('declares the base variable of every gate that compares with a base commit', () => {
		// A gate that picks its own base (the PR target, origin/main) checks a
		// different change than check:changed's merge base unless it is told.
		const readsBase = /GITHUB_BASE_REF|origin\/main/;
		for (const entry of ROOT_GATES) {
			const sources = gateScriptClosure(rootScripts[`lint:${entry.name}`] ?? '')
				.filter((file) => /\.(sh|ts)$/.test(file) && isFile(file))
				.map(read)
				.join('\n');
			if (entry.baseEnv) expect(sources, entry.name).toContain(entry.baseEnv);
			else expect(readsBase.test(sources), entry.name).toBe(false);
		}
		expect(ROOT_GATES.filter((entry) => entry.baseEnv).map((entry) => entry.name)).toEqual([
			'format',
			'comment-policy',
			'stored-block-corpus',
		]);
	});

	it('names only paths that exist', () => {
		const literal = [...ROOT_GATES, ...PLUGIN_SMOKES, SCRIPTS_TYPECHECK_INPUTS].flatMap((entry) =>
			entry.paths.filter((path) => !/[*?{]/.test(path))
		);
		for (const path of [...literal, ...GATE_GLOBAL_INPUTS])
			expect(existsSync(join(REPOSITORY_ROOT, path)), path).toBe(true);
		const workspaces = new Set(
			execFileSync('git', ['ls-files', '*package.json'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' })
				.split('\n')
				.filter(Boolean)
				.map((file) => (JSON.parse(read(file)) as { name?: string }).name)
		);
		for (const entry of [...ROOT_GATES, ...PLUGIN_SMOKES, SCRIPTS_TYPECHECK_INPUTS])
			for (const name of entry.packages ?? []) expect(workspaces.has(name), name).toBe(true);
	});

	it('selects plugin-imports exactly when the smokes that build its inputs run', () => {
		expect(gate('plugin-imports').paths).toEqual(PLUGIN_GRAPH_INPUTS.paths);
		expect(gate('plugin-imports').packages).toEqual(PLUGIN_GRAPH_INPUTS.packages);
		for (const smoke of PLUGIN_SMOKES) expect(smoke.paths).toEqual(PLUGIN_GRAPH_INPUTS.paths);
	});

	it('runs the Convex bundle smoke only for backend and plugin inputs', () => {
		const smoke = PLUGIN_SMOKES.find((entry) => entry.name === 'convex-bundle')!;
		const on = (changed: string[], affected: string[] = []) =>
			gateSelected(smoke, changed, new Set(affected), GATE_GLOBAL_INPUTS);
		expect(on(['apps/api/convex/mail/send.ts'], ['@owlat/api'])).toBe(true);
		expect(on(['examples/plugins/slack-approvals/src/index.ts'])).toBe(true);
		expect(on(['plugins.config.ts'])).toBe(true);
		// A shared change reaches the backend bundle through the package graph.
		expect(on(['packages/shared/src/mime.ts'], ['@owlat/shared', '@owlat/api'])).toBe(true);
		expect(on(['apps/web/app/pages/index.vue'], ['@owlat/web'])).toBe(false);
		expect(on(['apps/docs/content/en/1.index.md'], ['@owlat/docs'])).toBe(false);
	});

	it('selects gates from the files they read', () => {
		// A removed production caller anywhere can leave a shared export unreached.
		expect(selects('deadcode', ['apps/web/app/pages/index.vue'])).toBe(true);
		expect(selects('deadcode', ['apps/docs/content/en/1.index.md'])).toBe(false);
		expect(selects('compose', ['infra/templates/docker-compose.vps.yml'])).toBe(true);
		expect(selects('compose', ['.env.selfhost.example'])).toBe(true);
		expect(selects('compose', ['apps/web/app/pages/index.vue'])).toBe(false);
		expect(selects('branding', ['README.md'])).toBe(true);
		expect(selects('member-jargon', ['apps/web/i18n/locales/en.json'])).toBe(true);
		expect(selects('script-tests', ['apps/api/convex/mail/send.ts'], ['@owlat/api'])).toBe(false);
		expect(selects('script-tests', ['packages/shared/src/mime.ts'], ['@owlat/shared'])).toBe(true);
		// The root manifest and lockfile can change every gate's result.
		for (const entry of ROOT_GATES) {
			expect(selects(entry.name, ['package.json'])).toBe(true);
			expect(selects(entry.name, ['bun.lock'])).toBe(true);
			expect(selects(entry.name, [])).toBe(false);
		}
	});

	it('prints one command of plain words per line for ci-gate.sh', () => {
		expect(listCommands('smokes').split('\n')).toEqual(
			PLUGIN_SMOKES.map((smoke) => smoke.command.join(' '))
		);
		expect(listCommands('gates').split('\n')).toEqual(
			ROOT_GATES.map((entry) => gateCommand(entry).join(' '))
		);
		expect(listCommands('gates').split('\n')[0]).toBe('bun run lint:warnings');
		expect(listCommands('gates').split('\n').at(-1)).toBe(
			'bun packages/plugin-codegen/src/cli.ts --boundaries-only'
		);
		expect(() => listCommands('other')).toThrow(/usage/);
	});
});

describe('scripts/ci-gate.sh', () => {
	const runGate = (mode: string) => {
		const bin = mkdtempSync(join(tmpdir(), 'owlat-ci-gate-'));
		try {
			const log = join(bin, 'calls.log');
			const realBun = execFileSync('bash', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim();
			// The manifest listing runs for real; every step only records itself.
			writeFileSync(
				join(bin, 'bun'),
				`#!/usr/bin/env bash\nif [[ "$1" == scripts/ci/gates.ts ]]; then exec "${realBun}" "$@"; fi\necho "bun $*" >> "${log}"\n`,
				{ mode: 0o755 }
			);
			for (const tool of ['bunx', 'node'])
				writeFileSync(join(bin, tool), `#!/usr/bin/env bash\necho "${tool} $*" >> "${log}"\n`, {
					mode: 0o755,
				});
			const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env['PATH']}` };
			delete env['TURBO_CONCURRENCY'];
			execFileSync('bash', [join(REPOSITORY_ROOT, 'scripts/ci-gate.sh'), mode], {
				env,
				stdio: 'ignore',
			});
			return readFileSync(log, 'utf8').trim().split('\n');
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
	};

	it('runs every smoke, the turbo lint pass and every gate, in manifest order', () => {
		expect(runGate('lint')).toEqual([
			...PLUGIN_SMOKES.map((smoke) => smoke.command.join(' ')),
			'bunx turbo lint --filter=!@owlat/desktop',
			...ROOT_GATES.map((entry) => gateCommand(entry).join(' ')),
		]);
	});

	it('adds typecheck, tests and the scripts/ typecheck in verify mode', () => {
		const calls = runGate('verify');
		const turbo = calls.findIndex((call) => call.startsWith('bunx turbo'));
		expect(calls[turbo]).toBe(
			'bunx turbo lint typecheck test --concurrency=4 --filter=!@owlat/desktop'
		);
		expect(calls[turbo + 1]).toBe('bun run typecheck:scripts');
		expect(calls.slice(turbo + 2)).toEqual(ROOT_GATES.map((entry) => gateCommand(entry).join(' ')));
	});
});

describe('check:changed wiring', () => {
	it('is a root script', () => {
		expect(rootScripts['check:changed']).toBe('bun scripts/check-changed.ts');
	});

	it('bounds the CI lint job', () => {
		const workflow = read('.github/workflows/test.yml');
		const lintJob = workflow.slice(
			workflow.indexOf('\n  lint:\n'),
			workflow.indexOf('\n    steps:', workflow.indexOf('\n  lint:\n'))
		);
		expect(lintJob).toMatch(/\n    timeout-minutes: \d+/);
	});
});
