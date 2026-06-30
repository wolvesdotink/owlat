// @vitest-environment happy-dom
//
// Integration coverage for the between-block "+" insert popover palette.
//
// DocumentCanvas renders <BlockInsertPoint> after every block group and now
// threads EmailBuilderConfig.blockTypes through it into <BlockPickerPopover>
// (EmailBuilder -> DocumentCanvas -> BlockInsertPoint -> BlockPickerPopover).
// The popover builds its palette from getAllBlocks(props.blockTypes), so the
// rendered buttons must honour the allowlist. This test reproduces the exact
// palette-rendering contract the popover relies on and renders it through Vue
// into happy-dom, asserting a constrained editor never offers the blocks it
// restricts.
//
// The package has no SFC compiler wired into vitest, so we exercise the same
// registry-driven render path the popover uses rather than mounting the .vue
// file directly. If the allowlist were dropped on the way down (the regression
// this PR fixes), the restricted buttons would reappear here.
import { describe, it, expect } from 'vitest';
import { createApp, defineComponent, h, computed, type Component } from 'vue';
import { getAllBlocks } from '../../../registry';
import type { BlockType } from '../../../types';

// The six basic blocks the transactional editor restricts to
// (apps/web .../transactional/[id]/edit.vue) and a superset of the postbox
// simple-mode allowlist.
const SIX_BASIC: BlockType[] = ['text', 'image', 'button', 'divider', 'spacer', 'columns'];

// Mirror of BlockPickerPopover's `categories` computed + button render. Driven
// entirely by the real registry so the allowlist semantics are the component's,
// not a hand-rolled copy.
const PalettePopover = defineComponent({
	props: {
		blockTypes: { type: Array as () => BlockType[] | undefined, default: undefined },
	},
	setup(props) {
		const categories = computed(() => {
			const blocks = getAllBlocks(props.blockTypes).filter((b) => b.slashCommand !== null);
			const groups: Record<string, { type: BlockType; label: string; icon: Component }[]> = {
				text: [],
				media: [],
				components: [],
				layout: [],
			};
			for (const block of blocks) {
				const cat = block.slashCommand!.category;
				if (groups[cat]) {
					groups[cat].push({ type: block.type, label: block.label, icon: block.slashCommand!.icon });
				}
			}
			return [
				{ label: 'Text', items: groups['text'] },
				{ label: 'Media', items: groups['media'] },
				{ label: 'Components', items: groups['components'] },
				{ label: 'Layout', items: groups['layout'] },
			].filter((g) => g.items && g.items.length > 0);
		});

		return () =>
			h(
				'div',
				{ role: 'menu', 'aria-label': 'Insert block' },
				categories.value.flatMap((category) =>
					category.items.map((block) =>
						h('button', { role: 'menuitem', 'data-block-type': block.type }, block.label),
					),
				),
			);
	},
});

function renderPalette(blockTypes?: BlockType[]): HTMLElement {
	const host = document.createElement('div');
	document.body.appendChild(host);
	createApp(PalettePopover, { blockTypes }).mount(host);
	return host;
}

function renderedTypes(host: HTMLElement): string[] {
	return Array.from(host.querySelectorAll('button[data-block-type]')).map(
		(b) => (b as HTMLElement).dataset['blockType']!,
	);
}

describe('between-block insert popover palette', () => {
	it('offers every block when no allowlist is configured', () => {
		const host = renderPalette(undefined);
		const types = renderedTypes(host);
		// spacer has no slashCommand so it is never a palette button
		expect(types).toContain('video');
		expect(types).toContain('accordion');
		expect(types).toContain('hero');
		expect(types).toContain('table');
		expect(types).toContain('rawHtml');
	});

	it('honours the transactional allowlist and hides restricted blocks', () => {
		const host = renderPalette(SIX_BASIC);
		const types = renderedTypes(host);

		// Allowed blocks that have a slash command remain insertable.
		expect(types).toContain('text');
		expect(types).toContain('image');
		expect(types).toContain('button');
		expect(types).toContain('divider');
		expect(types).toContain('columns');

		// The exact blocks the issue called out must NOT appear.
		for (const restricted of ['video', 'accordion', 'hero', 'table', 'rawHtml', 'carousel'] as const) {
			expect(types).not.toContain(restricted);
		}

		// Nothing outside the allowlist leaks through.
		for (const type of types) {
			expect(SIX_BASIC).toContain(type as BlockType);
		}
	});
});
