/**
 * The page-header ratchet's own gate (#865).
 *
 * The comparison is scripts/ratchet.sh's and has its own suite; what is tested
 * here is the generator: which files count as hand-rolling a page header. It
 * must catch the h1 however its attributes are wrapped, and it must not count
 * the same classes on a stat value, or the advice "use UiPageHeader" would
 * block a metric card for no reason.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPTS = resolve(import.meta.dirname, '..');
const HAND_ROLLED = 'text-2xl font-medium tracking-[-0.02em]';

const sandboxes: string[] = [];
afterEach(() => {
	while (sandboxes.length > 0) {
		const dir = sandboxes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function sandbox(files: Record<string, string>, baseline: string[] | null): string {
	const root = mkdtempSync(join(tmpdir(), 'owlat-page-headers-'));
	sandboxes.push(root);
	mkdirSync(join(root, 'scripts'));
	for (const script of ['check-page-headers.sh', 'ratchet.sh']) {
		copyFileSync(join(SCRIPTS, script), join(root, 'scripts', script));
	}
	mkdirSync(join(root, 'apps/web/app'), { recursive: true });
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), contents);
	}
	if (baseline !== null) {
		writeFileSync(
			join(root, 'scripts/page-header-baseline.txt'),
			['# frozen debt', ...baseline].join('\n') + '\n'
		);
	}
	return root;
}

function run(root: string, args: string[] = []) {
	const result = spawnSync('bash', [join(root, 'scripts/check-page-headers.sh'), ...args], {
		cwd: root,
		encoding: 'utf8',
	});
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const handRolledPage = `<template>\n\t<h1 class="${HAND_ROLLED} text-text-primary">Title</h1>\n</template>\n`;
const migratedPage = `<template>\n\t<UiPageHeader :title="t('x.title')" />\n</template>\n`;

describe('page-header ratchet', () => {
	it('passes when every hand-rolled header is in the baseline', () => {
		const root = sandbox({ 'apps/web/app/pages/old.vue': handRolledPage }, [
			'apps/web/app/pages/old.vue',
		]);
		const result = run(root);

		expect(result.output).toContain('ok:   no new hand-rolled page headers (1 baseline');
		expect(result.status).toBe(0);
	});

	it('fails a new page that hand-rolls its h1 and points at UiPageHeader', () => {
		const root = sandbox(
			{
				'apps/web/app/pages/old.vue': handRolledPage,
				'apps/web/app/pages/new.vue': handRolledPage,
			},
			['apps/web/app/pages/old.vue']
		);
		const result = run(root);

		expect(result.output).toContain('1 file(s) hand-roll a page header h1');
		expect(result.output).toContain('apps/web/app/pages/new.vue');
		expect(result.output).toContain('UiPageHeader');
		expect(result.status).toBe(1);
	});

	it('catches an h1 whose class sits on a later line', () => {
		const wrapped = `<template>\n\t<h1\n\t\tid="title"\n\t\tclass="${HAND_ROLLED} flex items-center"\n\t>\n\t\tTitle\n\t</h1>\n</template>\n`;
		const root = sandbox({ 'apps/web/app/pages/wrapped.vue': wrapped }, []);
		const result = run(root);

		expect(result.output).toContain('apps/web/app/pages/wrapped.vue');
		expect(result.status).toBe(1);
	});

	it('fails a stale entry once the page moved to UiPageHeader, so the list only shrinks', () => {
		const root = sandbox({ 'apps/web/app/pages/old.vue': migratedPage }, [
			'apps/web/app/pages/old.vue',
		]);
		const result = run(root);

		expect(result.output).toContain('1 stale entr(y/ies)');
		expect(result.output).toContain('apps/web/app/pages/old.vue');
		expect(result.status).toBe(1);
	});

	it('does not count the same classes on a stat value', () => {
		const metric = `<template>\n\t<h2 class="text-sm">Sent</h2>\n\t<p class="${HAND_ROLLED} text-text-primary">42</p>\n</template>\n`;
		const root = sandbox({ 'apps/web/app/components/MetricCard.vue': metric }, []);
		const result = run(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it('does not reach outside apps/web/app, where the primitive itself lives', () => {
		const root = sandbox({ 'packages/ui/components/ui/PageHeader.vue': handRolledPage }, []);
		const result = run(root);

		expect(result.status).toBe(0);
	});

	it('fails when the baseline is missing and names the seed command', () => {
		const root = sandbox({ 'apps/web/app/pages/old.vue': handRolledPage }, null);
		const result = run(root);

		expect(result.output).toContain('check-page-headers.sh --write-baseline');
		expect(result.status).toBe(1);
	});

	it('reseeds the baseline sorted, keeping its comment header', () => {
		const root = sandbox(
			{
				'apps/web/app/pages/b.vue': handRolledPage,
				'apps/web/app/pages/a.vue': handRolledPage,
				'apps/web/app/pages/clean.vue': migratedPage,
			},
			[]
		);
		expect(run(root, ['--write-baseline']).status).toBe(0);
		const reseeded = readFileSync(join(root, 'scripts/page-header-baseline.txt'), 'utf8');

		expect(reseeded).toBe('# frozen debt\napps/web/app/pages/a.vue\napps/web/app/pages/b.vue\n');
	});
});
