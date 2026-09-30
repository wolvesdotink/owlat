/**
 * The composer's hosts give it a fixed height (a 440px popup, a 380px inline
 * reply). When the status strips above the body stack up — the seal banner, a
 * refused-save notice — they must give way, not the body: a notice saying
 * "everything you wrote is still here" over a zero-height editor is a lie.
 * So the body keeps a minimum height, the strips shrink and scroll, and the
 * draft notice leads them so it stays in view. Checked on the template AST;
 * mounting the full composer for three classes would test the harness.
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
	it('keeps a minimum height on the body', () => {
		const classes = attr(byTestId(ast, 'composer-body')!, 'class')!.split(/\s+/);
		expect(classes).toEqual(expect.arrayContaining(['min-h-24', 'flex-1']));
	});

	it('lets the status strips shrink and scroll, draft notice first', () => {
		const strips = byTestId(ast, 'composer-status-strips')!;
		expect(attr(strips, 'class')!.split(/\s+/)).toEqual(
			expect.arrayContaining(['min-h-0', 'overflow-y-auto'])
		);
		const elements = (strips.children ?? []).filter((c) => c.type === 1).map((c) => c.tag);
		expect(elements[0]).toBe('PostboxComposerDraftNotice');
		expect(elements).toEqual(
			expect.arrayContaining([
				'PostboxComposerSealLock',
				'PostboxDraftRestoreBar',
				'PostboxComposerScheduledBanner',
			])
		);
	});
});
