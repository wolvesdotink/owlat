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

function vueFiles(dir: string): string[] {
	return readdirSync(join(repo, dir)).flatMap((entry) => {
		const path = join(dir, entry);
		if (entry === 'node_modules' || entry === '__tests__') return [];
		if (statSync(join(repo, path)).isDirectory()) return vueFiles(path);
		return path.endsWith('.vue') ? [path] : [];
	});
}

describe('z-index layers', () => {
	it('toasts sit above the modal backdrop', () => {
		const toast = classLayer(read('packages/ui/components/ui/Toast.vue'), 'fixed bottom-6 right-6');
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
