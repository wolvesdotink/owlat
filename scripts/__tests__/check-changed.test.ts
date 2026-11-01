/**
 * `bun run check:changed` (scripts/check-changed.ts): change discovery against
 * temporary git repositories, the plan it builds from a change set, and how it
 * runs that plan. The selection helpers it plans with live in
 * scripts/ci/selection.ts and are covered here through the plan and directly.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
	CheckChangedError,
	buildPlan,
	changedFiles,
	ciAlsoRuns,
	main,
	parseJsonc,
	resolveMergeBase,
	runPlan,
	spawnStep,
	type PlanInput,
	type WorkspaceInfo,
} from '../check-changed';
import {
	pathPattern,
	planTests,
	rootInputSelection,
	type Change,
	type TestWorkspace,
	type TurboTaskConfig,
} from '../ci/selection';
import { NO_AUTO_MAINTENANCE } from './gitRepository.testlib';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const turboTasks = (
	parseJsonc(readFileSync(join(REPOSITORY_ROOT, 'turbo.json'), 'utf8')) as {
		tasks: Record<string, TurboTaskConfig>;
	}
).tasks;

// ---- git discovery ---------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
function write(root: string, path: string, contents = 'export const value = 1;\n'): void {
	const absolute = join(root, path);
	mkdirSync(resolve(absolute, '..'), { recursive: true });
	writeFileSync(absolute, contents);
}
function repository(): string {
	const root = mkdtempSync(join(tmpdir(), 'owlat-check-changed-'));
	roots.push(root);
	git(root, ['init', '--quiet', '--initial-branch=main']);
	git(root, ['config', 'user.email', 'test@example.com']);
	git(root, ['config', 'user.name', 'Check Changed Test']);
	git(root, ['config', 'commit.gpgsign', 'false']);
	git(root, [...NO_AUTO_MAINTENANCE]);
	for (const file of ['kept.ts', 'edited.ts', 'deleted.ts', 'renamed-from.ts', 'staged.ts'])
		write(root, file);
	git(root, ['add', '.']);
	git(root, ['commit', '--quiet', '-m', 'base']);
	git(root, ['checkout', '--quiet', '-b', 'feature']);
	return root;
}

describe('change discovery', () => {
	it('collects committed, staged, unstaged and untracked changes since the merge base', () => {
		const root = repository();
		write(root, 'committed.ts');
		git(root, ['add', '.']);
		git(root, ['commit', '--quiet', '-m', 'branch']);
		// main moves on after the branch point; its new file is not a branch change.
		git(root, ['checkout', '--quiet', 'main']);
		write(root, 'main-only.ts');
		git(root, ['add', '.']);
		git(root, ['commit', '--quiet', '-m', 'main moves']);
		git(root, ['checkout', '--quiet', 'feature']);

		write(root, 'staged.ts', 'export const value = 2;\n');
		git(root, ['add', 'staged.ts']);
		write(root, 'edited.ts', 'export const value = 3;\n');
		git(root, ['rm', '--quiet', 'deleted.ts']);
		git(root, ['mv', 'renamed-from.ts', 'renamed-to.ts']);
		write(root, 'odd name\nwith ümlaut.ts');
		write(root, 'ignored.log');
		write(root, '.gitignore', '*.log\n');

		const mergeBase = resolveMergeBase(root, 'main');
		expect(mergeBase).toBe(git(root, ['rev-parse', 'HEAD~1']));
		expect(changedFiles(root, mergeBase)).toEqual([
			{ path: '.gitignore', deleted: false },
			{ path: 'committed.ts', deleted: false },
			{ path: 'deleted.ts', deleted: true },
			{ path: 'edited.ts', deleted: false },
			{ path: 'odd name\nwith ümlaut.ts', deleted: false },
			{ path: 'renamed-from.ts', deleted: true },
			{ path: 'renamed-to.ts', deleted: false },
			{ path: 'staged.ts', deleted: false },
		]);
	});

	it('reports an empty change set when the tree matches the merge base', () => {
		const root = repository();
		expect(changedFiles(root, resolveMergeBase(root, 'main'))).toEqual([]);
		expect(main(['main'], root)).toBe(0);
	});

	it('fails loudly on an unknown base or one with no merge base', () => {
		const root = repository();
		expect(() => resolveMergeBase(root, 'origin/main')).toThrow(CheckChangedError);
		expect(() => resolveMergeBase(root, 'origin/main')).toThrow(/git fetch origin/);
		git(root, ['checkout', '--quiet', '--orphan', 'unrelated']);
		git(root, ['commit', '--quiet', '-m', 'unrelated root']);
		git(root, ['checkout', '--quiet', 'feature']);
		expect(() => resolveMergeBase(root, 'unrelated')).toThrow(/no merge base/);
	});

	it('rejects extra positional arguments', () => {
		const root = repository();
		expect(() => main(['main', 'other'], root)).toThrow(/usage/);
		expect(() => main(['--verbose'], root)).toThrow(/usage/);
	});
});

// ---- parsing -----------------------------------------------------------------

describe('parseJsonc', () => {
	it('drops comments and trailing commas but keeps comment markers inside strings', () => {
		expect(
			parseJsonc(`{
				// line comment
				"a": "$TURBO_ROOT$/apps/**/*.ts", /* block */
				"b": ["// not a comment", "quote \\" /* kept */",],
			}`)
		).toEqual({ a: '$TURBO_ROOT$/apps/**/*.ts', b: ['// not a comment', 'quote " /* kept */'] });
	});

	it('reads the real turbo.json', () => {
		expect(turboTasks['@owlat/api#lint']?.inputs).toContain('$TURBO_ROOT$/apps/**/*.{ts,vue}');
	});
});

// ---- selection helpers ---------------------------------------------------------

describe('path patterns', () => {
	it.each([
		['apps/web/', 'apps/web/app/x.vue', true],
		['apps/web/', 'apps/website/x.vue', false],
		['packages/*/src/', 'packages/shared/src/deep/a.ts', true],
		['packages/*/src/', 'packages/shared/test/a.ts', false],
		['package.json', 'package.json', true],
		['package.json', 'apps/web/package.json', false],
		['**/package.json', 'package.json', true],
		['**/package.json', 'apps/web/package.json', true],
		['scripts/*.ts', 'scripts/__tests__/x.ts', false],
		['scripts/**/*.ts', 'scripts/__tests__/x.ts', true],
		['{apps,packages}/**/*.{ts,vue}', 'packages/ui/a/B.vue', true],
		['{apps,packages}/**/*.{ts,vue}', 'examples/a.ts', false],
		['.env*', '.env.selfhost.example', true],
		['.env*', 'apps/mta/.env.example', false],
		['docker-compose*.yml', 'docker-compose.vps.yml', true],
		['a+b.ts', 'aab.ts', false],
		['**', 'anything/at/all.md', true],
	])('%s matches %s: %s', (pattern, file, expected) => {
		expect(pathPattern(pattern).test(file)).toBe(expected);
	});
});

const workspace = (name: string, directory: string, scripts: Record<string, string> = {}) => ({
	name,
	directory,
	scripts: {
		lint: 'oxlint',
		typecheck: 'tsc --noEmit',
		test: 'vitest run',
		'test:coverage': 'vitest run --coverage',
		...scripts,
	},
});
const WORKSPACES: WorkspaceInfo[] = [
	workspace('@owlat/api', 'apps/api'),
	workspace('@owlat/web', 'apps/web'),
	workspace('@owlat/setup-cli', 'apps/setup-cli'),
	workspace('@owlat/desktop', 'apps/desktop'),
	workspace('@owlat/shared', 'packages/shared'),
	workspace('@owlat/decision-local', 'apps/decision-local', {
		test: 'python3 -m unittest discover -s tests',
	}),
];
const NAMES = WORKSPACES.map((w) => w.name);

describe('turbo root inputs', () => {
	it('sends an env-key edit in the backend to the setup-cli env sync lint', () => {
		expect(rootInputSelection(turboTasks, 'lint', ['apps/api/convex/lib/env.ts'], NAMES)).toContain(
			'@owlat/setup-cli'
		);
		expect(
			rootInputSelection(turboTasks, 'lint', ['packages/shared/src/convexRuntimeEnv.ts'], NAMES)
		).toContain('@owlat/setup-cli');
	});

	it('sends a web caller change to the api entry-wiring lint', () => {
		expect(rootInputSelection(turboTasks, 'lint', ['apps/web/app/pages/index.vue'], NAMES)).toEqual(
			['@owlat/api']
		);
	});

	it('widens a generic root input to every workspace', () => {
		expect(
			rootInputSelection(turboTasks, 'typecheck', ['scripts/perf-bench/sampler.ts'], NAMES)
		).toEqual(NAMES);
		expect(rootInputSelection(turboTasks, 'typecheck', ['scripts/other.ts'], NAMES)).toEqual([]);
	});
});

describe('test planning', () => {
	const ws = (name: string, directory: string, related = true): TestWorkspace => ({
		package: name,
		name: name.slice(7),
		directory,
		related,
	});
	const api = ws('@owlat/api', 'apps/api', false);
	const web = ws('@owlat/web', 'apps/web');
	const tree: Record<string, string[]> = {
		'apps/api/convex/mail': ['outbound.ts', 'other.ts'],
		'apps/api/convex/mail/__tests__': ['outbound.test.ts', 'outboundRetry.test.ts'],
		'apps/api/convex/__tests__': ['outbound.integration.test.ts', 'other.test.ts'],
	};
	const list = (directory: string) => tree[directory] ?? [];
	const change = (path: string, deleted = false): Change => ({ path, deleted });

	it('gives the API suite its changed and neighbouring test files, never related', () => {
		const [plan] = planTests(
			[api],
			[change('apps/api/convex/mail/outbound.ts'), change('apps/api/convex/x/__tests__/y.test.ts')],
			list
		);
		expect(plan).toEqual({
			workspace: api,
			mode: 'files',
			files: [
				'apps/api/convex/__tests__/outbound.integration.test.ts',
				'apps/api/convex/mail/__tests__/outbound.test.ts',
				'apps/api/convex/x/__tests__/y.test.ts',
			],
		});
	});

	it('hands related workspaces every present changed file', () => {
		const [plan] = planTests(
			[web],
			[
				change('packages/shared/src/a.ts'),
				change('apps/web/app/b.vue'),
				change('apps/api/gone.ts', true),
			],
			list
		);
		expect(plan).toEqual({
			workspace: web,
			mode: 'related',
			files: ['packages/shared/src/a.ts', 'apps/web/app/b.vue'],
		});
	});

	it('runs a whole suite when related cannot follow the change', () => {
		const reason = (changes: Change[], target = web) => {
			const [plan] = planTests([target], changes, list);
			return plan!.mode === 'full' ? plan!.reason : plan!.mode;
		};
		expect(reason([change('apps/web/app/gone.ts', true)])).toBe('apps/web/app/gone.ts was deleted');
		expect(reason([change('apps/web/vitest.config.ts')])).toBe('apps/web/vitest.config.ts changed');
		expect(reason([change('apps/web/app/__tests__/setup.ts')])).toBe(
			'apps/web/app/__tests__/setup.ts changed'
		);
		expect(reason([change('apps/api/package.json')], api)).toBe('apps/api/package.json changed');
		expect(reason([change('bun.lock')])).toBe('bun.lock changed');
		expect(reason([change('vitest.shared.ts')])).toBe('vitest.shared.ts changed');
		expect(reason([change('package.json')])).toBe('related');
	});
});

// ---- the plan ----------------------------------------------------------------

function plan(changes: Change[], affected: string[], env: PlanInput['env'] = {}) {
	return buildPlan({
		mergeBase: 'abc123',
		changes,
		workspaces: WORKSPACES,
		affected: new Set(affected),
		turboTasks,
		images: [
			{ name: 'web', package: '@owlat/web', dockerfile: 'apps/web/Dockerfile' },
			{
				name: 'convex-deploy',
				package: '@owlat/api',
				dockerfile: 'docker/convex-deploy.Dockerfile',
			},
		],
		listDirectory: () => [],
		vitestBin: () => 'node_modules/.bin/vitest',
		env,
	});
}
const names = (p: ReturnType<typeof plan>) => p.steps.map((step) => step.name);
const step = (p: ReturnType<typeof plan>, prefix: string) =>
	p.steps.find((entry) => entry.name.startsWith(prefix));

describe('buildPlan', () => {
	it('checks a web-only change without the backend smokes, and lints the api callers', () => {
		const p = plan([{ path: 'apps/web/app/pages/index.vue', deleted: false }], ['@owlat/web']);
		expect(step(p, 'format')).toMatchObject({
			command: ['bun', 'run', 'lint:format'],
			env: { OXFMT_BASE: 'abc123', GITHUB_BASE_REF: undefined },
		});
		// The comment policy scans the whole tree, so it takes no base.
		expect(step(p, 'lint:comment-policy')).toEqual({
			name: 'lint:comment-policy',
			command: ['bun', 'run', 'lint:comment-policy'],
		});
		expect(step(p, 'oxlint')?.command).toEqual([
			'node_modules/.bin/oxlint',
			'--config',
			'oxlintrc.json',
			'apps/web/app/pages/index.vue',
		]);
		expect(names(p).some((name) => name.startsWith('smoke'))).toBe(false);
		expect(step(p, 'lint (')?.command).toEqual([
			'node_modules/.bin/turbo',
			'run',
			'lint',
			'--filter=@owlat/api',
			'--filter=@owlat/web',
		]);
		expect(step(p, 'typecheck (')?.command).toEqual([
			'node_modules/.bin/turbo',
			'run',
			'typecheck',
			'--concurrency=4',
			'--filter=@owlat/web',
		]);
		expect(names(p)).not.toContain('typecheck scripts/');
		expect(names(p)).toContain('lint:ui-controls');
		expect(names(p)).not.toContain('lint:compose');
		expect(step(p, 'test @owlat/web')).toEqual({
			name: 'test @owlat/web (related)',
			command: [
				'node_modules/.bin/vitest',
				'related',
				'--run',
				'--passWithNoTests',
				'--maxWorkers=4',
				'app/pages/index.vue',
			],
			cwd: 'apps/web',
		});
		expect(p.skipped).toContain('smoke convex-bundle');
		expect(p.skipped).toContain('lint:compose');
		expect(p.skipped).not.toContain('lint:ui-controls');
		const ci = ciAlsoRuns(p);
		expect(ci[0]).toMatch(
			/^lint: every root gate and plugin smoke \(not run here: .*smoke convex-bundle/
		);
		expect(ci).toContain('test-web: the full web suite with coverage');
		expect(ci).toContain(
			'test-web-browser: the web component tests in Chrome (bun run --cwd apps/web test:browser)'
		);
		expect(ci).toContain('docker-build: image builds: web');
		expect(ci.some((line) => line.startsWith('test-api'))).toBe(false);
	});

	it('runs the plugin smokes in CI order for a backend change, and only neighbour API tests', () => {
		const p = plan([{ path: 'apps/api/convex/mail/send.ts', deleted: false }], ['@owlat/api']);
		expect(names(p).filter((name) => name.startsWith('smoke'))).toEqual([
			'smoke api-graph',
			'smoke deploy-graph',
			'smoke clean-checkout',
			'smoke convex-bundle',
			'smoke convex-function-graph',
		]);
		const smokes = names(p).indexOf('smoke api-graph');
		expect(smokes).toBeLessThan(names(p).indexOf('lint (1 workspaces)'));
		expect(names(p).at(-1)).toBe('lint:plugin-imports');
		expect(p.steps.some((entry) => entry.command.includes('related'))).toBe(false);
		expect(p.notes).toEqual([
			'@owlat/api: no changed or neighbouring test files; CI runs its full suite',
		]);
		expect(ciAlsoRuns(p)).toContain('test-api: the full API suite with coverage');
	});

	it('never hands related an empty file list', () => {
		const p = plan(
			[{ path: 'packages/shared/src/gone.ts', deleted: true }],
			['@owlat/shared', '@owlat/web']
		);
		expect(step(p, 'test @owlat/shared')?.name).toBe(
			'test @owlat/shared (full suite: packages/shared/src/gone.ts was deleted)'
		);
		expect(step(p, 'test @owlat/web')).toBeUndefined();
		expect(p.notes).toEqual(['@owlat/web: only deleted files changed; CI runs its full suite']);
	});

	it('leaves the desktop shell and non-vitest suites to CI, and honours the bounds', () => {
		const p = plan(
			[
				{ path: 'apps/desktop/src/a.ts', deleted: false },
				{ path: 'apps/decision-local/app.py', deleted: false },
			],
			['@owlat/desktop', '@owlat/decision-local'],
			{ TURBO_CONCURRENCY: '2', VITEST_MAX_WORKERS: '1' }
		);
		expect(p.steps.some((entry) => entry.command.includes('--filter=@owlat/desktop'))).toBe(false);
		expect(names(p).some((name) => name.startsWith('test '))).toBe(false);
		expect(step(p, 'typecheck (')?.command).toContain('--concurrency=2');
		const q = plan(
			[{ path: 'packages/shared/src/a.ts', deleted: false }],
			['@owlat/shared', '@owlat/web'],
			{ VITEST_MAX_WORKERS: '1' }
		);
		expect(step(q, 'test @owlat/web')?.command).toContain('--maxWorkers=1');
		expect(names(q)).toContain('typecheck scripts/');
		expect(names(q)).toContain('lint:script-tests');
	});

	it("gives every gate that compares with a base the run's merge base", () => {
		const p = plan(
			[{ path: 'packages/email-renderer/src/__tests__/storedBlocks/a.json', deleted: false }],
			[]
		);
		expect(step(p, 'lint:stored-block-corpus')).toMatchObject({
			command: ['bun', 'run', 'lint:stored-block-corpus'],
			env: { STORED_BLOCK_CORPUS_BASE: 'abc123', GITHUB_BASE_REF: undefined },
		});
		// A gate without a base runs in the caller's environment.
		expect(step(p, 'lint:branding')?.env).toBeUndefined();
	});

	it('runs the scripts/ checks for a scripts-only change and no workspace task', () => {
		const p = plan([{ path: 'scripts/check-format.sh', deleted: false }], []);
		expect(names(p)).toEqual([
			'format (oxfmt)',
			'lint:script-tests',
			'lint:branding',
			'lint:comment-policy',
			'lint:source-bytes',
			'lint:no-pr-assets',
		]);
		const q = plan([{ path: 'scripts/ci/gates.ts', deleted: false }], []);
		expect(names(q)).toContain('typecheck scripts/');
		expect(names(q)).toContain('lint:scripts');
		expect(names(q)).toContain('lint:warnings');
		expect(names(q).some((name) => /^(lint|typecheck) \(/.test(name))).toBe(false);
	});
});

// ---- running -----------------------------------------------------------------

describe('running the plan', () => {
	it('runs every step after a failure and reports each result', () => {
		const p = plan([{ path: 'apps/web/app/pages/index.vue', deleted: false }], ['@owlat/web']);
		const seen: string[] = [];
		const results = runPlan(
			p,
			(entry) => {
				seen.push(entry.name);
				return entry.name.startsWith('oxlint') ? 1 : 0;
			},
			() => {}
		);
		expect(seen).toEqual(names(p));
		expect(results.filter((result) => !result.ok).map((result) => result.name)).toEqual([
			'oxlint (1 files)',
		]);
	});

	it('spawns in the workspace directory with the step environment', () => {
		const root = mkdtempSync(join(tmpdir(), 'owlat-check-changed-run-'));
		roots.push(root);
		mkdirSync(join(root, 'apps/web'), { recursive: true });
		process.env['GITHUB_BASE_REF'] = 'main';
		try {
			const spawn = spawnStep(root);
			const check = `[ "$(pwd)" = "${join(root, 'apps/web')}" ] && [ "$OXFMT_BASE" = abc ] && [ -z "\${GITHUB_BASE_REF+x}" ]`;
			expect(
				spawn({
					name: 'env',
					command: ['bash', '-c', check],
					cwd: 'apps/web',
					env: { OXFMT_BASE: 'abc', GITHUB_BASE_REF: undefined },
				})
			).toBe(0);
			expect(spawn({ name: 'fails', command: ['bash', '-c', 'exit 3'] })).toBe(3);
			expect(spawn({ name: 'missing', command: ['./no-such-binary'] })).toBe(1);
		} finally {
			delete process.env['GITHUB_BASE_REF'];
		}
	});
});
