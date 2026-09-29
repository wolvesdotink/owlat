// Container and hero both hold an `items` list of container children, so they
// share one panel projection and one child-type allowlist (_itemsChildren.ts).
import { describe, it, expect } from 'vitest';
import { editorModuleFor, getAllEditorModules } from '..';
import { itemsChildrenView, containerChildTypes } from '../_itemsChildren';
import type { ContainerItem } from '../../types';

const items = [
	{ id: 'i1', type: 'text', content: {} },
	{ id: 'i2', type: 'button', content: {} },
] as unknown as ContainerItem[];

describe('items-block child helpers', () => {
	it('container and hero use the shared helpers', () => {
		for (const type of ['container', 'hero'] as const) {
			const mod = editorModuleFor(type);
			expect(mod?.childrenView).toBe(itemsChildrenView);
			expect(mod?.allowedChildTypes).toBe(containerChildTypes);
		}
	});

	it('projects each item to its module label and icon', () => {
		const rows = itemsChildrenView({ content: { items } });
		expect(rows.map(({ id, type, label }) => ({ id, type, label }))).toEqual([
			{ id: 'i1', type: 'text', label: 'Text' },
			{ id: 'i2', type: 'button', label: 'Button' },
		]);
		expect(rows.every((r) => r.icon !== null)).toBe(true);
	});

	it('treats a missing items list as empty', () => {
		expect(itemsChildrenView({ content: {} })).toEqual([]);
	});

	it('allows exactly the modules flagged canBeInContainer', () => {
		const expected = getAllEditorModules()
			.filter((m) => m.canBeInContainer)
			.map((m) => m.type);
		expect(containerChildTypes()).toEqual(expected);
		expect(containerChildTypes()).toContain('text');
		expect(containerChildTypes()).not.toContain('hero');
	});
});
