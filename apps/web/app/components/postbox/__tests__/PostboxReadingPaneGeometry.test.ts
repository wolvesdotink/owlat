// @vitest-environment node
/**
 * The reading-pane geometry contract between PostboxLayout.vue and
 * postbox-panes.css.
 *
 * The layout publishes ONE `data-reading-pane` attribute plus the two seam
 * custom properties and marks the three boxes with hook classes; the stylesheet
 * owns every dimension. Reading the source rather than mounting: the behaviour
 * IS the CSS cascade (happy-dom has no layout engine to resolve it) and the
 * layout needs a live Convex client to mount at all. What this pins down is the
 * pairing — a renamed hook class or a dropped rule would silently restore the
 * one hardcoded geometry this replaced, and nothing else would notice.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const panes = read('../../../assets/css/postbox-panes.css');
const layout = read('../PostboxLayout.vue');
const main = read('../../../assets/css/main.css');

/** The declaration block of the first rule whose selector matches exactly. */
function block(selector: string): string {
	const match = new RegExp(
		`(?:^|\\n)\\s*${selector.replace(/[.[\]()*+?^$|\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
	).exec(panes);
	expect(match, `rule for \`${selector}\` in postbox-panes.css`).not.toBeNull();
	return match![1]!;
}

describe('reading-pane stylesheet', () => {
	it('is loaded by the app stylesheet', () => {
		expect(main).toContain("@import './postbox-panes.css';");
	});

	it('sizes the side-by-side list from the persisted width', () => {
		expect(block("[data-reading-pane='right'] .pbx-pane-list")).toContain(
			'width: var(--pbx-list-width'
		);
	});

	it('flips the split to a column and sizes the list by height when stacked', () => {
		expect(block("[data-reading-pane='bottom'] .pbx-pane-split")).toContain(
			'flex-direction: column'
		);
		expect(block("[data-reading-pane='bottom'] .pbx-pane-list")).toContain(
			'height: var(--pbx-list-height'
		);
	});

	it('gives the list the whole width when the pane is off', () => {
		const off = block("[data-reading-pane='off'] .pbx-pane-list");
		expect(off).toContain('width: 100%');
		expect(off).toContain('flex: 1 1 auto');
	});
});

describe('layout hooks', () => {
	it('marks the three boxes the stylesheet targets', () => {
		for (const hook of ['pbx-pane-split', 'pbx-pane-list', 'pbx-pane-reader']) {
			expect(layout, hook).toContain(hook);
		}
	});
});
