/**
 * The repeated-id repair behind migration 0055 (issue #1083).
 *
 * Emails saved before duplication renewed descendant ids hold copies of
 * composite Blocks that share ids. The repair keeps the first occurrence of
 * each id, renews the later ones and copies the overlay entry of every renewed
 * Block, so the sent email gets distinct accordion toggles and each copy keeps
 * its translation while becoming translatable on its own.
 */

import { describe, expect, it } from 'vitest';
import { childBlockLists, ownedEntries, type BlockTreeNode } from '@owlat/shared/blockTree';
import { repairRepeatedBlockIds, repairRowRepeatedIds } from '../repeatedBlockIds';
import { TEMPLATE_TRANSLATABLE_FIELDS, updateTranslationPatch } from '../emailTranslations';
import { rerenderRow } from '../../emailBlocks/rendering';

type Overlays = Record<string, { subject: string; blocks: Record<string, { html?: string }> }>;

const text = (id: string, html = '<p>Hello</p>'): BlockTreeNode => ({
	id,
	type: 'text',
	content: { html, blockType: 'paragraph', fontSize: 14, textColor: '#000000' },
});
const container = (id: string, items: BlockTreeNode[]): BlockTreeNode => ({
	id,
	type: 'container',
	content: { items },
});
const hero = (id: string, items: BlockTreeNode[]): BlockTreeNode => ({
	id,
	type: 'hero',
	content: { items },
});
const columns = (id: string, cols: BlockTreeNode[][]): BlockTreeNode => ({
	id,
	type: 'columns',
	content: { columns: cols },
});
const accordion = (id: string, sectionIds: string[], itemPrefix = 'a'): BlockTreeNode => ({
	id,
	type: 'accordion',
	content: {
		allowMultiple: false,
		sections: sectionIds.map((sectionId, index) => ({
			id: sectionId,
			title: `Section ${index + 1}`,
			items: [text(`${itemPrefix}${index + 1}`, `<p>Answer ${index + 1}</p>`)],
		})),
	},
});

function blockIds(roots: BlockTreeNode[]): string[] {
	const ids: string[] = [];
	const visit = (node: BlockTreeNode): void => {
		ids.push(node.id);
		for (const list of childBlockLists(node)) list.forEach(visit);
	};
	roots.forEach(visit);
	return ids;
}

function sectionIds(roots: BlockTreeNode[]): string[] {
	const ids: string[] = [];
	const visit = (node: BlockTreeNode): void => {
		for (const entry of ownedEntries(node)) ids.push(entry['id'] as string);
		for (const list of childBlockLists(node)) list.forEach(visit);
	};
	roots.forEach(visit);
	return ids;
}

function counter(): () => string {
	let n = 0;
	return () => `fresh-${++n}`;
}

describe('repairRepeatedBlockIds', () => {
	it('keeps the first occurrence and renews every later one, at any depth', () => {
		const roots = [
			container('outer', [container('inner', [text('deep')])]),
			container('outer-copy', [container('inner', [text('deep')])]),
			hero('hero', [text('h1')]),
			hero('hero-copy', [text('h1')]),
			columns('cols', [[text('c1')], [text('c2')]]),
			columns('cols-copy', [[text('c1')], [text('c2')]]),
		];
		const counts = repairRepeatedBlockIds(roots, {}, counter());

		expect(counts).toEqual({ blocks: 5, sections: 0 });
		const ids = blockIds(roots);
		expect(new Set(ids).size).toBe(ids.length);
		// First copies are untouched.
		expect(blockIds([roots[0]!, roots[2]!, roots[4]!])).toEqual([
			'outer',
			'inner',
			'deep',
			'hero',
			'h1',
			'cols',
			'c1',
			'c2',
		]);
	});

	it('renews repeated accordion section ids, including blank ids within one accordion', () => {
		const roots = [
			accordion('acc', ['s1', 's2'], 'a'),
			accordion('acc-copy', ['s1', 's2'], 'b'),
			accordion('acc-added', ['', ''], 'c'),
		];
		const counts = repairRepeatedBlockIds(roots, {}, counter());

		expect(counts).toEqual({ blocks: 0, sections: 3 });
		const ids = sectionIds(roots);
		expect(ids.slice(0, 2)).toEqual(['s1', 's2']);
		expect(ids[4]).toBe('');
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('copies the overlay entry of each renewed Block in every language', () => {
		const roots = [container('box', [text('t1')]), container('box-copy', [text('t1'), text('t2')])];
		const overlays: Overlays = {
			de: {
				subject: 'Hallo',
				blocks: { t1: { html: '<p>Hallo</p>' }, t2: { html: '<p>Zwei</p>' } },
			},
			fr: { subject: 'Bonjour', blocks: { t1: { html: '<p>Bonjour</p>' } } },
		};
		repairRepeatedBlockIds(roots, overlays, counter());

		const renewed = blockIds([roots[1]!])[1]!;
		expect(renewed).not.toBe('t1');
		expect(overlays['de']!.blocks).toEqual({
			t1: { html: '<p>Hallo</p>' },
			t2: { html: '<p>Zwei</p>' },
			[renewed]: { html: '<p>Hallo</p>' },
		});
		expect(overlays['fr']!.blocks).toEqual({
			t1: { html: '<p>Bonjour</p>' },
			[renewed]: { html: '<p>Bonjour</p>' },
		});
		// A copy, not a shared object: editing one entry leaves the other.
		expect(overlays['de']!.blocks[renewed]).not.toBe(overlays['de']!.blocks['t1']);
	});

	it('never hands out an id already used by a Block, a section or an overlay key', () => {
		const roots = [container('box', [text('t1')]), container('fresh-1', [text('t1')])];
		const overlays: Overlays = { de: { subject: '', blocks: { 'fresh-2': { html: 'x' } } } };
		repairRepeatedBlockIds(roots, overlays, counter());
		expect(blockIds([roots[1]!])).toEqual(['fresh-1', 'fresh-3']);
	});
});

describe('repairRowRepeatedIds', () => {
	it('leaves a row without repeated ids alone', () => {
		const content = JSON.stringify([container('box', [text('t1')]), accordion('acc', ['s1'])]);
		expect(repairRowRepeatedIds({ content }, counter())).toEqual({ kind: 'unchanged' });
	});

	it('keeps the stored document shape around the block list', () => {
		const content = JSON.stringify({
			version: 2,
			blocks: [container('box', [text('t1')]), container('box-copy', [text('t1')])],
		});
		const repair = repairRowRepeatedIds({ content }, counter());
		expect(repair.kind).toBe('repaired');
		if (repair.kind !== 'repaired') return;
		const stored = JSON.parse(repair.content) as { version: number; blocks: BlockTreeNode[] };
		expect(stored.version).toBe(2);
		expect(blockIds(stored.blocks)).toEqual(['box', 't1', 'box-copy', 'fresh-1']);
		expect(repair.translations).toBeUndefined();
	});

	it('refuses to repair a row whose overlays it cannot read, and ignores them otherwise', () => {
		const repeated = JSON.stringify([container('a', [text('t1')]), container('b', [text('t1')])]);
		const unique = JSON.stringify([container('a', [text('t1')])]);
		expect(repairRowRepeatedIds({ content: repeated, translations: '{' }, counter())).toEqual({
			kind: 'unreadable',
			field: 'translations',
		});
		expect(repairRowRepeatedIds({ content: unique, translations: '{' }, counter())).toEqual({
			kind: 'unchanged',
		});
		expect(repairRowRepeatedIds({ content: 'not json' }, counter())).toEqual({
			kind: 'unreadable',
			field: 'content',
		});
	});
});

describe('repaired rows render correctly', () => {
	it('gives two copies of an accordion their own toggles', () => {
		const content = JSON.stringify([
			accordion('acc', ['s1', 's2'], 'a'),
			accordion('acc-copy', ['s1', 's2'], 'b'),
		]);
		const before = rerenderRow({ content, subject: 'Hi' }, 'personalization', undefined).html;
		const beforeIds = [...before.matchAll(/<input [^>]*id="(owlat-acc-[^"]*)"/g)].map((m) => m[1]);
		expect(new Set(beforeIds).size).toBe(2);

		const repair = repairRowRepeatedIds({ content }, counter());
		if (repair.kind !== 'repaired') throw new Error(`expected a repair, got ${repair.kind}`);
		const html = rerenderRow(
			{ content: repair.content, subject: 'Hi' },
			'personalization',
			undefined
		).html;

		const toggles = [
			...html.matchAll(/<input [^>]*id="(owlat-acc-[^"]*)"[^>]*\/><label for="([^"]*)"/g),
		];
		expect(toggles).toHaveLength(4);
		const ids = toggles.map((m) => m[1]);
		expect(new Set(ids).size).toBe(4);
		// Each header's label points at the input right before it.
		for (const [, id, labelFor] of toggles) expect(labelFor).toBe(id);
	});

	it('keeps the German text of both copies of a Container, then lets them diverge', () => {
		const row = {
			subject: 'Hello',
			defaultLanguage: 'en',
			supportedLanguages: ['en', 'de'],
			content: JSON.stringify([
				container('box', [text('t1')]),
				container('box-copy', [text('t1')]),
			]),
			translations: JSON.stringify({
				de: { subject: 'Hallo', blocks: { t1: { html: '<p>Hallo Welt</p>' } } },
			}),
		};
		const germanOf = (r: typeof row): string => {
			const rendered = rerenderRow(r, 'personalization', undefined).htmlTranslations;
			return (JSON.parse(rendered!) as Record<string, { htmlContent: string }>)['de']!.htmlContent;
		};
		const count = (html: string, needle: string) => html.split(needle).length - 1;
		expect(count(germanOf(row), 'Hallo Welt')).toBe(2);

		const repair = repairRowRepeatedIds(row, counter());
		if (repair.kind !== 'repaired') throw new Error(`expected a repair, got ${repair.kind}`);
		const repaired = { ...row, content: repair.content, translations: repair.translations! };
		expect(count(germanOf(repaired), 'Hallo Welt')).toBe(2);

		// Translate the second copy differently through the regular overlay write.
		const copyChildId = blockIds(JSON.parse(repair.content) as BlockTreeNode[])[3]!;
		const overlays = JSON.parse(repaired.translations) as Overlays;
		const edited = updateTranslationPatch(
			repaired,
			{
				language: 'de',
				blocks: JSON.stringify({
					...overlays['de']!.blocks,
					[copyChildId]: { html: '<p>Servus</p>' },
				}),
			},
			TEMPLATE_TRANSLATABLE_FIELDS
		);
		const german = germanOf({ ...repaired, translations: edited.translations! });
		expect(count(german, 'Hallo Welt')).toBe(1);
		expect(count(german, 'Servus')).toBe(1);
		expect(german.indexOf('Hallo Welt')).toBeLessThan(german.indexOf('Servus'));
	});
});
