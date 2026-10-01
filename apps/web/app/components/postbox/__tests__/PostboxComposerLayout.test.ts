/**
 * The composer's hosts give it a fixed height (a 440px popup, a 380px inline
 * reply). Everything between the envelope and the footer is one scroll region:
 * the status strips keep their natural height with the draft notice first,
 * the body keeps at least 6rem, and the footer (Send) stays outside it, pinned.
 * Squeezing either the strips or the body would hide what the notice promises
 * ("everything you wrote is still here"). The region is the shared frame's
 * (`PostboxComposerShell`, #812), which the mailbox composer and the Team inbox
 * reply both render in. Checked on the template AST; mounting the full
 * composer for a few classes would test the harness.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@vue/compiler-sfc';

type Node = { type: number; tag?: string; props?: Prop[]; children?: Node[] };
type Prop = { name: string; value?: { content: string }; arg?: { content: string } };

function templateOf(file: string): Node {
	const path = resolve(__dirname, file);
	return parse(readFileSync(path, 'utf8'), { filename: path }).descriptor.template!.ast as Node;
}

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

function byTag(node: Node, tag: string): Node | null {
	if (node.type === 1 && node.tag === tag) return node;
	for (const child of node.children ?? []) {
		const found = byTag(child, tag);
		if (found) return found;
	}
	return null;
}

const elementsOf = (node: Node) => (node.children ?? []).filter((c) => c.type === 1);
/** `<template #name>` inside a component. */
const slotTemplate = (node: Node, name: string) =>
	elementsOf(node).find(
		(c) =>
			c.tag === 'template' && c.props?.some((p) => p.name === 'slot' && p.arg?.content === name)
	);
/** A component's default-slot content: its children outside any `<template #…>`. */
const defaultSlot = (node: Node) => elementsOf(node).filter((c) => c.tag !== 'template');

describe('PostboxComposerShell: one scroll region, the footer pinned outside it', () => {
	const shell = templateOf('../PostboxComposerShell.vue');
	const root = elementsOf(shell)[0]!;
	const region = byTestId(shell, 'composer-scroll')!;

	it('scrolls the region between envelope and footer as one', () => {
		expect(attr(region, 'class')!.split(/\s+/)).toEqual(
			expect.arrayContaining(['flex', 'flex-col', 'flex-1', 'min-h-0', 'overflow-y-auto'])
		);
		// The host's content is the region's: nothing else, no nested scroller.
		expect(elementsOf(region).map((c) => c.tag)).toEqual(['slot']);
	});

	it('puts the envelope above the region and the footer below it, outside', () => {
		const order = elementsOf(root).map((c) =>
			c === region ? 'region' : c.tag === 'slot' ? attr(c, 'name') : c.tag
		);
		expect(order.filter((n) => n !== 'div')).toEqual(['header', 'envelope', 'region', 'footer']);
	});
});

describe('PostboxComposer in the shell', () => {
	const shell = byTag(templateOf('../PostboxComposer.vue'), 'PostboxComposerShell')!;
	const content = defaultSlot(shell);

	it('leads with the draft notice and keeps the strips at their natural height', () => {
		expect(content[0]!.tag).toBe('PostboxComposerDraftNotice');
		expect(content.map((c) => c.tag)).toEqual(
			expect.arrayContaining([
				'PostboxComposerSealLock',
				'PostboxDraftRestoreBar',
				'PostboxComposerScheduledBanner',
			])
		);
		// No nested scroller or shrink wrapper that could squeeze them.
		expect(byTestId(shell, 'composer-status-strips')).toBeNull();
	});

	it('keeps a minimum height on the body inside the region', () => {
		const body = content.find((c) => attr(c, 'data-testid') === 'composer-body')!;
		expect(attr(body, 'class')!.split(/\s+/)).toEqual(
			expect.arrayContaining(['min-h-24', 'flex-1'])
		);
	});

	it('hands the footer to the shell’s footer slot, so Send stays pinned', () => {
		expect(byTag(slotTemplate(shell, 'footer')!, 'PostboxComposerFooter')).not.toBeNull();
		expect(content.some((c) => byTag(c, 'PostboxComposerFooter'))).toBe(false);
	});
});

describe('the Team inbox reply in the same shell (#812)', () => {
	const shell = byTag(templateOf('../../inbox/ThreadComposer.vue'), 'PostboxComposerShell')!;

	it('renders its editor in the region and Send in the shared footer', () => {
		expect(byTestId(shell, 'thread-composer-body')).not.toBeNull();
		expect(byTag(slotTemplate(shell, 'footer')!, 'PostboxComposerFooter')).not.toBeNull();
		expect(defaultSlot(shell).some((c) => byTag(c, 'PostboxComposerFooter'))).toBe(false);
	});
});
