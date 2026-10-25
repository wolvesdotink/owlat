/**
 * The stacking order the named z-index layers in packages/ui tokens.css
 * promise, checked against the components that paint them.
 *
 * Two ways it broke: the toast stack sat at z-50, the same layer as the modal
 * backdrop, so a toast raised from inside a dialog (a failed save in the
 * save-block dialog) rendered blurred under the backdrop; and the email
 * builder's floating block rail and formatting toolbar sat at z 999/1000, so
 * they drew on top of every modal backdrop. Two modals then opted into
 * z 10001 to clear the builder, which in turn buried toasts under them.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

const layers = new Map(
	[...read('packages/ui/assets/css/tokens.css').matchAll(/--z-([a-z-]+):\s*(\d+)/g)].map(
		([, name, value]) => [name!, Number(value)]
	)
);
const layer = (name: string) => {
	const value = layers.get(name);
	if (value === undefined) throw new Error(`tokens.css has no --z-${name}`);
	return value;
};

/** The z layer an element's class list puts it on, from `z-(--z-name)`. */
function classLayer(source: string, marker: string): number {
	const tag = source.split('\n').find((line) => line.includes(marker));
	const token = tag && /\bz-\(--z-([a-z-]+)\)/.exec(tag)?.[1];
	if (!token) throw new Error(`no z-(--z-*) layer on the element marked by "${marker}"`);
	return layer(token);
}

const skippedDirs = new Set(['node_modules', '__tests__', 'dist', '.nuxt', '.output']);

function sourceFiles(dir: string, extensions: readonly string[]): string[] {
	return readdirSync(join(repo, dir)).flatMap((entry) => {
		const path = join(dir, entry);
		if (skippedDirs.has(entry)) return [];
		if (statSync(join(repo, path)).isDirectory()) return sourceFiles(path, extensions);
		return extensions.some((extension) => path.endsWith(extension)) ? [path] : [];
	});
}

const vueFiles = (dir: string) => sourceFiles(dir, ['.vue']);

/** Every literal z-index in a source file: `z-[N]`, `z-index: N`, `zIndex: N`, `z-index="N"`. */
function rawZIndexes(source: string): { match: string; value: number }[] {
	const patterns = [
		/(?<![\w-])z-\[(\d+)\]/g,
		/z-index:\s*(\d+)/g,
		/zIndex:\s*['"]?(\d+)/g,
		/z-index="(\d+)"/g,
	];
	return patterns.flatMap((pattern) =>
		[...source.matchAll(pattern)].map(([match, value]) => ({ match, value: Number(value) }))
	);
}

/**
 * Raw z-index values allowed at or above the tooltip layer. The workspace
 * switch skeleton stands in for the whole window while it reloads, so it must
 * cover everything, tooltips included.
 */
const aboveTooltipAllowed = new Set(['apps/web/app/lib/desktop/workspaceSwitch.ts']);

describe('z-index layers', () => {
	it('toasts sit above the modal backdrop', () => {
		// Marked by what makes it the stack (a fixed, click-through container),
		// not by its offsets, which change with the phone/safe-area geometry.
		const toast = classLayer(
			read('packages/ui/components/ui/Toast.vue'),
			'pointer-events-none fixed'
		);
		const backdrop = classLayer(read('packages/ui/components/ui/Modal.vue'), 'fixed inset-0');
		expect(toast).toBeGreaterThan(backdrop);
		expect(toast).toBeGreaterThan(layer('overlay'));
	});

	it("the email builder's floating chrome sits under the modal backdrop", () => {
		const backdrop = layer('modal');
		const rail = classLayer(
			read('packages/email-builder/src/components/canvas/FloatingBlockSidebar.vue'),
			'light fixed'
		);
		const toolbar = classLayer(
			read('packages/email-builder/src/components/canvas/UnifiedToolbar.vue'),
			'light fixed'
		);
		expect(rail).toBeLessThan(backdrop);
		expect(toolbar).toBeLessThan(backdrop);
		// The toolbar's settings popover is positioned inline.
		expect(read('packages/email-builder/src/components/canvas/UnifiedToolbar.vue')).toContain(
			"zIndex: 'var(--z-float)'"
		);
	});

	it('tooltips sit above every other layer, toasts included', () => {
		const tooltip = classLayer(read('packages/ui/components/ui/Tooltip.vue'), "'ui-tooltip fixed");
		expect(tooltip).toBe(layer('tooltip'));
		expect(Math.max(...layers.values())).toBe(tooltip);
	});

	it("the email builder's popovers sit above its floating chrome and under tooltips", () => {
		const popovers = [
			['packages/email-builder/src/components/canvas/DocumentCanvas.vue', 'w-[240px]'],
			['packages/email-builder/src/components/canvas/BlockPickerPopover.vue', 'w-[280px]'],
			['packages/email-builder/src/components/canvas/SavedBlockPickerMenu.vue', 'w-80'],
			['packages/email-builder/src/components/panel/fields/SelectField.vue', 'scrollbar-thin'],
		] as const;
		for (const [path, marker] of popovers) {
			const popover = classLayer(read(path), marker);
			expect(popover, path).toBeGreaterThan(layer('float'));
			expect(popover, path).toBeGreaterThan(layer('modal'));
			expect(popover, path).toBeLessThan(layer('tooltip'));
		}
	});

	it("the builder's focus-mode chrome sits over its floating chrome and under the modal backdrop", () => {
		const overlay = read('packages/email-builder/src/components/FocusModeOverlay.vue');
		const fixed = overlay.split('\n').filter((line) => line.includes('class="fixed '));
		expect(fixed).toHaveLength(3);
		for (const line of fixed) {
			const chrome = classLayer(line, 'class="fixed ');
			expect(chrome).toBeGreaterThan(layer('float'));
			expect(chrome).toBeLessThan(layer('modal'));
		}
	});

	it('no raw z-index outranks the tooltip layer', () => {
		// A tooltip is mounted on <body>, so anything painted above --z-tooltip
		// can hide the label of a control it contains or sits next to.
		const tooltip = layer('tooltip');
		const raised = [
			'apps/web/app',
			'apps/docs/app',
			'apps/marketing/app',
			'packages/ui',
			'packages/email-builder/src',
		]
			.flatMap((dir) => sourceFiles(dir, ['.vue', '.ts', '.css']))
			.filter((path) => !aboveTooltipAllowed.has(path))
			.flatMap((path) =>
				rawZIndexes(read(path))
					.filter(({ value }) => value >= tooltip)
					.map(({ match }) => `${path}: ${match}`)
			);
		expect(raised).toEqual([]);
	});

	it('the raw z-index scan reads every notation', () => {
		expect(
			rawZIndexes(
				'class="fixed z-[9999] hover:z-[10] -z-[1]" z-index: 5; zIndex: \'2147483000\', zIndex: 7 :z-index="200"'
			).map(({ value }) => value)
		).toEqual([9999, 10, 5, 2147483000, 7, 200]);
		expect(rawZIndexes(read('apps/web/app/lib/desktop/workspaceSwitch.ts'))).toContainEqual({
			match: "zIndex: '2147483000",
			value: 2147483000,
		});
	});

	it('no modal raises itself above the toast stack', () => {
		const toast = layer('toast');
		const raised = ['apps/web/app', 'packages/ui/components', 'packages/email-builder/src']
			.flatMap(vueFiles)
			.flatMap((path) =>
				[...read(path).matchAll(/:z-index="(\d+)"/g)]
					.filter(([, value]) => Number(value) >= toast)
					.map(([match]) => `${path}: ${match}`)
			);
		expect(raised).toEqual([]);
	});
});
