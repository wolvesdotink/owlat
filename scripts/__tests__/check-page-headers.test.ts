/**
 * The page-header gate's own gate.
 *
 * The comparison is scripts/ratchet.sh's and has its own suite; what is tested
 * here is the generator: which files count as hand-rolling a page header. It
 * must catch the h1 however its attributes are wrapped, and it must not count
 * the same classes on a stat value, or the advice "use UiPageHeader" would
 * block a metric card for no reason. The debt is gone, so the gate runs with
 * no baseline: any hand-rolled header fails.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function sandbox(files: Record<string, string>): string {
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
const slottedPage = `<template>\n\t<UiPageHeader>\n\t\t<template #title>Hi, <span class="lp-title-accent">Ada</span></template>\n\t</UiPageHeader>\n</template>\n`;

describe('page-header gate', () => {
	it('passes when every page renders UiPageHeader', () => {
		const root = sandbox({
			'apps/web/app/pages/a.vue': migratedPage,
			'apps/web/app/pages/b.vue': slottedPage,
		});
		const result = run(root);

		expect(result.output).toContain('ok:   no hand-rolled page headers');
		expect(result.status).toBe(0);
	});

	it('fails a page that hand-rolls its h1 and points at UiPageHeader', () => {
		const root = sandbox({
			'apps/web/app/pages/clean.vue': migratedPage,
			'apps/web/app/pages/new.vue': handRolledPage,
		});
		const result = run(root);

		expect(result.output).toContain('1 file(s) hand-roll a page header h1');
		expect(result.output).toContain('apps/web/app/pages/new.vue');
		expect(result.output).not.toContain('apps/web/app/pages/clean.vue');
		expect(result.output).toContain('UiPageHeader');
		expect(result.status).toBe(1);
	});

	it('catches an h1 whose class sits on a later line', () => {
		const wrapped = `<template>\n\t<h1\n\t\tid="title"\n\t\tclass="${HAND_ROLLED} flex items-center"\n\t>\n\t\tTitle\n\t</h1>\n</template>\n`;
		const root = sandbox({ 'apps/web/app/pages/wrapped.vue': wrapped });
		const result = run(root);

		expect(result.output).toContain('apps/web/app/pages/wrapped.vue');
		expect(result.status).toBe(1);
	});

	it('catches the title scale behind a responsive prefix', () => {
		const responsive = `<template>\n\t<h1 class="text-xl sm:${HAND_ROLLED}">Subject</h1>\n</template>\n`;
		const root = sandbox({ 'apps/web/app/components/Reader.vue': responsive });
		const result = run(root);

		expect(result.output).toContain('apps/web/app/components/Reader.vue');
		expect(result.status).toBe(1);
	});

	it('does not count the same classes on a stat value', () => {
		const metric = `<template>\n\t<h2 class="text-sm">Sent</h2>\n\t<p class="${HAND_ROLLED} text-text-primary">42</p>\n</template>\n`;
		const root = sandbox({ 'apps/web/app/components/MetricCard.vue': metric });
		const result = run(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it('does not reach outside apps/web/app, where the primitive itself lives', () => {
		const root = sandbox({ 'packages/ui/components/ui/PageHeader.vue': handRolledPage });
		const result = run(root);

		expect(result.status).toBe(0);
	});

	it('reads no baseline, so a leftover baseline file cannot excuse a page', () => {
		const root = sandbox({ 'apps/web/app/pages/old.vue': handRolledPage });
		writeFileSync(join(root, 'scripts/page-header-baseline.txt'), 'apps/web/app/pages/old.vue\n');
		const result = run(root);

		expect(existsSync(join(root, 'scripts/page-header-baseline.txt'))).toBe(true);
		expect(result.output).toContain('apps/web/app/pages/old.vue');
		expect(result.status).toBe(1);
	});
});
