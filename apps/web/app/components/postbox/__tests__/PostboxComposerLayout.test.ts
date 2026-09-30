/**
 * The composer's hosts give it a fixed height (a 440px popup, a 380px inline
 * reply). Everything between the envelope and the footer is one scroll region:
 * the status strips keep their natural height with the draft notice first,
 * the body keeps at least 6rem, and the footer (Send) stays outside it, pinned.
 * Squeezing either the strips or the body would hide what the notice promises
 * ("everything you wrote is still here"). Checked on the template AST; mounting
 * the full composer for a few classes would test the harness.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@vue/compiler-sfc';

type Node = { type: number; tag?: string; props?: Prop[]; children?: Node[] };
type Prop = { name: string; value?: { content: string } };

const path = resolve(__dirname, '../PostboxComposer.vue');
const ast = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor.template!.ast as Node;

function attr(node: Node, name: string): string | undefined {
	return node.props?.find((p) => p.name === name)?.value?.content;
}

function byTestId(node: Node, id: string): Node | null {
	if (node.type === 1 && attr(node, 'data-testid') === id) return node;
	for (const child of node.children ?? []) {
		const found = byTestId(child, id);
		if (found) return found;
	}
	return null;
}

describe('PostboxComposer layout under stacked status strips', () => {
	const region = byTestId(ast, 'composer-scroll')!;
	const elements = (region.children ?? []).filter((c) => c.type === 1);

	it('scrolls the region between envelope and footer as one', () => {
		expect(attr(region, 'class')!.split(/\s+/)).toEqual(
			expect.arrayContaining(['flex', 'flex-col', 'flex-1', 'min-h-0', 'overflow-y-auto'])
		);
	});

	it('leads with the draft notice and keeps the strips at their natural height', () => {
		expect(elements[0]!.tag).toBe('PostboxComposerDraftNotice');
		expect(elements.map((c) => c.tag)).toEqual(
			expect.arrayContaining([
				'PostboxComposerSealLock',
				'PostboxDraftRestoreBar',
				'PostboxComposerScheduledBanner',
			])
		);
		// No nested scroller or shrink wrapper that could squeeze them.
		expect(byTestId(ast, 'composer-status-strips')).toBeNull();
	});

	it('keeps a minimum height on the body inside the region', () => {
		const body = elements.find((c) => attr(c, 'data-testid') === 'composer-body')!;
		expect(attr(body, 'class')!.split(/\s+/)).toEqual(
			expect.arrayContaining(['min-h-24', 'flex-1'])
		);
	});

	it('keeps the footer outside the region, so Send stays pinned', () => {
		const root = (ast.children ?? []).find((c) => c.type === 1)!;
		const siblings = (root.children ?? []).filter((c) => c.type === 1);
		const footerAt = siblings.findIndex((c) => c.tag === 'PostboxComposerFooter');
		expect(footerAt).toBeGreaterThan(siblings.indexOf(region));
		expect(elements.some((c) => c.tag === 'PostboxComposerFooter')).toBe(false);
	});
});
