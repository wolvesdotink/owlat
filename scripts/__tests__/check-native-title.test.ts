/**
 * The native-title gate's own gate: which `title`s it reads as tooltips on
 * controls, and which it must leave alone because they are metadata.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nativeTitleFindings, nativeTitleSites } from '../native-title-findings';

const sfc = (template: string) => `<template>\n${template}\n</template>\n`;
const sites = (template: string) => nativeTitleSites(sfc(template));

describe('nativeTitleSites', () => {
	it('flags a static or bound title on a native control, across wrapped lines', () => {
		expect(
			sites(`
	<div>
		<button
			type="button"
			title="Archive"
			@click="archive"
		>
			<ArchiveIcon />
		</button>
		<a href="/x" :title="t('open')">Open</a>
		<input v-bind:title="hint" />
	</div>`)
		).toEqual(['button\ttitle="Archive"', `a\t:title="t('open')"`, 'input\tv-bind:title="hint"']);
	});

	it('flags the app button and link components', () => {
		expect(
			sites(`
	<div>
		<UiButton variant="ghost" :title="label"><Icon name="x" /></UiButton>
		<NuxtLink to="/settings" :title="
			titleFor('settings')
		"><Icon name="y" /></NuxtLink>
	</div>`)
		).toEqual(['UiButton\t:title="label"', `NuxtLink\t:title=" titleFor('settings') "`]);
	});

	it('flags a native element made interactive', () => {
		expect(
			sites(`
	<div>
		<div role="button" title="Expand" />
		<span tabindex="0" title="Focusable" />
		<li @click="pick" :title="name" />
		<div role="menuitem" title="Item" />
	</div>`)
		).toEqual([
			'div\ttitle="Expand"',
			'span\ttitle="Focusable"',
			'li\t:title="name"',
			'div\ttitle="Item"',
		]);
	});

	it('leaves metadata titles alone', () => {
		expect(
			sites(`
	<div>
		<span class="truncate" :title="file.name">{{ file.name }}</span>
		<iframe :srcdoc="html" :title="t('preview')" />
		<UiModal :open="open" :title="t('dialog.heading')" />
		<UiEmptyState title="Nothing here" />
		<abbr title="Domain-based Message Authentication">DMARC</abbr>
		<div role="region" title="Summary" />
		<UiTooltip :text="t('archive')"><button :aria-label="t('archive')" /></UiTooltip>
	</div>`)
		).toEqual([]);
	});

	it('keeps a title the comment right before the control vouches for as metadata', () => {
		expect(
			sites(`
	<div>
		<!-- native-title: the full address of a truncated link -->
		<NuxtLink class="truncate" :to="href" :title="address">{{ address }}</NuxtLink>
		<!-- some other comment -->
		<button title="Still a tooltip" />
		<!-- native-title: -->
		<button title="An empty reason does not count" />
	</div>`)
		).toEqual([
			'button\ttitle="Still a tooltip"',
			'button\ttitle="An empty reason does not count"',
		]);
	});

	it('reads controls under v-if branches and inside slots', () => {
		expect(
			sites(`
	<UiDropdownMenu>
		<template #trigger>
			<button v-if="a" title="One" />
			<button v-else title="Two" />
		</template>
	</UiDropdownMenu>`)
		).toEqual(['button\ttitle="One"', 'button\ttitle="Two"']);
	});

	it('throws on a template it cannot parse', () => {
		expect(() => nativeTitleSites('<template><button title="x"></template>')).toThrow();
	});
});

describe('nativeTitleFindings', () => {
	const sandboxes: string[] = [];
	afterEach(() => {
		while (sandboxes.length > 0) rmSync(sandboxes.pop()!, { recursive: true, force: true });
	});

	function tree(files: Record<string, string>): string {
		const root = mkdtempSync(join(tmpdir(), 'owlat-native-title-'));
		sandboxes.push(root);
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), content);
		}
		return root;
	}

	it('walks every app and package root, skipping tests and build output, one line per site', () => {
		const control = sfc('<button title="Archive" />');
		const root = tree({
			'apps/web/app/components/A.vue': sfc('<div><button title="x" /><button title="x" /></div>'),
			'apps/marketing/app/B.vue': control,
			'apps/docs/app/C.vue': control,
			'packages/ui/components/ui/D.vue': control,
			'packages/email-builder/src/E.vue': control,
			'apps/web/app/components/__tests__/F.vue': control,
			'apps/web/app/.nuxt/G.vue': control,
			'packages/email-builder/test/H.vue': control,
		});
		expect(nativeTitleFindings(root)).toEqual([
			'apps/docs/app/C.vue\tbutton\ttitle="Archive"',
			'apps/marketing/app/B.vue\tbutton\ttitle="Archive"',
			'apps/web/app/components/A.vue\tbutton\ttitle="x"',
			'apps/web/app/components/A.vue\tbutton\ttitle="x"',
			'packages/email-builder/src/E.vue\tbutton\ttitle="Archive"',
			'packages/ui/components/ui/D.vue\tbutton\ttitle="Archive"',
		]);
	});

	it('names the file it cannot read', () => {
		const root = tree({ 'apps/web/app/Broken.vue': '<template><button></template>' });
		expect(() => nativeTitleFindings(root)).toThrow(/apps\/web\/app\/Broken\.vue/);
	});
});
