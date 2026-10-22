/**
 * lint:no-pr-assets keeps plans, PR captures and the screenshot harness out of
 * the index. The cases cover every prohibited shape, the product docs and
 * shipped images it must leave alone, a force-add past `.gitignore`, and a
 * deletion of an already-tracked file.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROHIBITED_DIRECTORIES, findPrAssets } from '../check-no-pr-assets';

const SCRIPT = resolve(import.meta.dirname, '../check-no-pr-assets.ts');
const REPO_ROOT = resolve(import.meta.dirname, '../..');

const sandboxes: string[] = [];
afterEach(() => {
	while (sandboxes.length > 0) rmSync(sandboxes.pop()!, { recursive: true, force: true });
});

describe('findPrAssets', () => {
	it.each([
		'docs/plans/ai-routing-plan.md',
		'docs/ux-plan/DEFERRALS.md',
		'docs/ui-polish/comparison/before/postbox.png',
		'docs/screenshots/dialog-focus/after.png',
		'docs/screenshots/notes.md',
		'scripts/uiaudit/capture.mjs',
		'apps/web/app/lib/uiMock/fixtures.ts',
	])('rejects %s', (path) => {
		expect(findPrAssets([path])).toEqual([expect.objectContaining({ path })]);
	});

	it.each([
		'docs/design/after.png',
		'docs/operations/recording.webm',
		'docs/security/2026-09-20/diagram.JPG',
	])('rejects a capture anywhere under docs/: %s', (path) => {
		expect(findPrAssets([path])).toEqual([{ path, reason: 'image or recording under docs/' }]);
	});

	it.each([
		'MAILBOX_STREAMLINE_PLAN_2026-08-29.html',
		'INBOX_ZERO_PLAN_2026-10-17.md',
		'x-plan.html',
	])('rejects a session plan at the repository root: %s', (path) => {
		expect(findPrAssets([path])).toEqual([{ path, reason: 'plan at the repository root' }]);
	});

	it('accepts documentation and shipped images outside the prohibited paths', () => {
		expect(
			findPrAssets([
				'README.md',
				'CONTEXT.md',
				'docs/README.md',
				'docs/RELEASING.md',
				'docs/operations/development.md',
				'docs/security/2026-09-20/http-routes.csv',
				'apps/docs/content/en/1.guide/27.postbox.md',
				'apps/docs/public/screenshots/postbox.png',
				'apps/marketing/public/og.png',
				'apps/web/public/favicon.png',
				'apps/web/app/lib/uiMockless.ts',
				'scripts/uiaudit-notes.ts',
				'apps/docs/content/en/5.vision/ROADMAP_PLAN_2026.md',
			])
		).toEqual([]);
	});
});

describe('.gitignore', () => {
	it.each(PROHIBITED_DIRECTORIES)('ignores %s, so a plain `git add` skips it', (directory) => {
		const probe = `${directory}probe.png`;
		const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', probe], {
			cwd: REPO_ROOT,
		});
		expect(result.status, `${probe} is not ignored`).toBe(0);
	});
});

describe('the gate on a repository', () => {
	function git(root: string, args: string[]): void {
		execFileSync('git', args, { cwd: root, stdio: 'pipe' });
	}

	function write(root: string, path: string, content = 'x\n'): void {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}

	function sandbox(): string {
		const root = mkdtempSync(join(tmpdir(), 'owlat-no-pr-assets-'));
		sandboxes.push(root);
		mkdirSync(join(root, 'scripts'));
		copyFileSync(SCRIPT, join(root, 'scripts/check-no-pr-assets.ts'));
		git(root, ['init', '--quiet']);
		git(root, ['config', 'user.email', 'test@example.com']);
		git(root, ['config', 'user.name', 'Gate Test']);
		write(root, '.gitignore', '/docs/screenshots/\n');
		write(root, 'docs/README.md');
		git(root, ['add', '.']);
		git(root, ['commit', '--quiet', '-m', 'baseline']);
		return root;
	}

	function run(root: string): { status: number | null; output: string } {
		const result = spawnSync('bun', ['scripts/check-no-pr-assets.ts'], {
			cwd: root,
			encoding: 'utf8',
		});
		return { status: result.status, output: `${result.stdout}${result.stderr}` };
	}

	it('passes a tree with documentation only', () => {
		expect(run(sandbox()).status).toBe(0);
	});

	it('fails on a capture force-added past .gitignore, and passes once it is removed', () => {
		const root = sandbox();
		write(root, 'docs/screenshots/feature/after.png');
		git(root, ['add', '--force', 'docs/screenshots/feature/after.png']);
		git(root, ['commit', '--quiet', '-m', 'add capture']);

		const failed = run(root);
		expect(failed.status).toBe(1);
		expect(failed.output).toContain('docs/screenshots/feature/after.png');

		git(root, ['rm', '--quiet', 'docs/screenshots/feature/after.png']);
		expect(run(root).status).toBe(0);
	});

	it('reads the index, so a staged harness file fails before it is committed', () => {
		const root = sandbox();
		write(root, 'scripts/uiaudit/capture.mjs');
		git(root, ['add', 'scripts/uiaudit/capture.mjs']);

		const failed = run(root);
		expect(failed.status).toBe(1);
		expect(failed.output).toContain('scripts/uiaudit/capture.mjs (under scripts/uiaudit/)');
	});
});
