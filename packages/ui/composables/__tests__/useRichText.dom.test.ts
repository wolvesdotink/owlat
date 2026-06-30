import { describe, it, expect } from 'vitest';
import {
	findAncestor,
	getNearestBlock,
	unwrapElement,
	replaceTagPreservingChildren,
} from '../useRichText';

function editorWith(html: string): HTMLElement {
	const root = document.createElement('div');
	root.innerHTML = html;
	document.body.appendChild(root);
	return root;
}

describe('findAncestor', () => {
	it('finds a matching ancestor inside the editor boundary', () => {
		const root = editorWith('<p><strong id="s"><em id="e">x</em></strong></p>');
		const em = root.querySelector('#e')!;
		const found = findAncestor(root, em, 'strong');
		expect(found?.id).toBe('s');
	});

	it('does not escape the editor root', () => {
		const outer = document.createElement('section');
		const root = document.createElement('div');
		outer.appendChild(root);
		root.innerHTML = '<span id="inner">x</span>';
		const found = findAncestor(root, root.querySelector('#inner')!, 'section');
		expect(found).toBeNull();
	});
});

describe('getNearestBlock', () => {
	it('returns the closest block-level container', () => {
		const root = editorWith('<ul><li id="li"><em id="e">x</em></li></ul>');
		const block = getNearestBlock(root, root.querySelector('#e')!);
		expect(block?.id).toBe('li');
	});
});

describe('unwrapElement', () => {
	it('hoists children and removes the wrapper', () => {
		const root = editorWith('<p><span id="wrap">a<b>b</b></span></p>');
		unwrapElement(root.querySelector('#wrap')!);
		expect(root.querySelector('#wrap')).toBeNull();
		expect(root.querySelector('p')?.textContent).toBe('ab');
		expect(root.querySelector('b')).not.toBeNull();
	});
});

describe('replaceTagPreservingChildren', () => {
	it('swaps the tag and keeps children + order', () => {
		const root = editorWith('<div id="d">hello <b>bold</b></div>');
		const replaced = replaceTagPreservingChildren(root.querySelector('#d')!, 'p');
		expect(replaced.tagName).toBe('P');
		expect(root.querySelector('p')?.innerHTML).toBe('hello <b>bold</b>');
		expect(root.querySelector('div#d')).toBeNull();
	});
});
