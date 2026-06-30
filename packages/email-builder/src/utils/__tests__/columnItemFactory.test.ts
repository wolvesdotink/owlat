import { describe, it, expect, afterEach } from 'vitest';
import { createDefaultColumnItemContent, createColumnItem } from '../blocks';
import { registerBlock } from '../../registry';
import { getBlock } from '../../registry/blockRegistry';
import { defaultTheme } from '../../defaults';
import type {
	TextBlockContent,
	ImageBlockContent,
	ButtonBlockContent,
	DividerBlockContent,
	SpacerBlockContent,
	BlockType,
	BlockContent,
	EmailTheme,
} from '../../types';

// =============================================================================
// Bucket 1 — Unit: factory uses the registry lifecycle
// =============================================================================
describe('createDefaultColumnItemContent — uses the block registry', () => {
	it('resolves the createDefaultColumnItem factory through getBlock(type)', () => {
		// Each column-eligible built-in block defines createDefaultColumnItem
		for (const type of ['text', 'image', 'button', 'divider', 'spacer'] as const) {
			const def = getBlock(type);
			expect(def).toBeDefined();
			expect(def!.createDefaultColumnItem).toBeTypeOf('function');
		}
	});

	it('throws a clear error for unknown block types', () => {
		expect(() =>
			createDefaultColumnItemContent('not-a-block' as unknown as BlockType),
		).toThrowError(/Unknown column item type/);
	});

	it('throws when a block exists but is not column-eligible', () => {
		// 'columns' and 'social' are not allowed inside a column
		expect(() => createDefaultColumnItemContent('columns' as never)).toThrowError(
			/cannot be used inside a column/,
		);
	});
});

// =============================================================================
// Bucket 2 — Contract: every column-eligible block produces the documented shape
// =============================================================================
describe('createDefaultColumnItemContent — contract for every column-eligible built-in', () => {
	const cases: Array<{ type: BlockType; assertContent: (c: BlockContent) => void }> = [
		{
			type: 'text',
			assertContent: (c) => {
				const t = c as TextBlockContent;
				expect(t.blockType).toBe('paragraph');
				expect(typeof t.fontSize).toBe('number');
				expect(typeof t.textColor).toBe('string');
			},
		},
		{
			type: 'image',
			assertContent: (c) => {
				const i = c as ImageBlockContent;
				expect(i.src).toBe('');
				expect(i.align).toBe('center');
				expect(i.width).toBe(100);
			},
		},
		{
			type: 'button',
			assertContent: (c) => {
				const b = c as ButtonBlockContent;
				expect(b.text).toBe('Click here');
				expect(b.url).toBe('https://');
				expect(b.align).toBe('center');
				expect(typeof b.backgroundColor).toBe('string');
			},
		},
		{
			type: 'divider',
			assertContent: (c) => {
				const d = c as DividerBlockContent;
				expect(d.thickness).toBe(1);
				expect(d.style).toBe('solid');
			},
		},
		{
			type: 'spacer',
			assertContent: (c) => {
				const s = c as SpacerBlockContent;
				expect(typeof s.height).toBe('number');
				expect(s.height).toBeGreaterThan(0);
			},
		},
	];

	for (const { type, assertContent } of cases) {
		it(`${type}: returns column-shaped content`, () => {
			const content = createDefaultColumnItemContent(type as never);
			assertContent(content);
		});
	}
});

// =============================================================================
// Bucket 3 — Behavior-parity: column-context defaults match the legacy switch
// =============================================================================
describe('createDefaultColumnItemContent — parity with legacy column defaults', () => {
	it('text: keeps compact column-context defaults (no top-level html, fontSize 14, no horizontal padding)', () => {
		const text = createDefaultColumnItemContent('text' as never) as TextBlockContent;
		expect(text.html).toBe('');
		expect(text.fontSize).toBe(14);
		expect(text.paddingLeft).toBe(0);
		expect(text.paddingRight).toBe(0);
	});

	it('button: keeps compact paddings (16/8) and no margin in column context', () => {
		const btn = createDefaultColumnItemContent('button' as never) as ButtonBlockContent;
		expect(btn.paddingX).toBe(16);
		expect(btn.paddingY).toBe(8);
		expect(btn.marginTop).toBe(0);
		expect(btn.marginBottom).toBe(0);
	});

	it('spacer: column spacer is 16px (vs top-level 20px)', () => {
		const sp = createDefaultColumnItemContent('spacer' as never) as SpacerBlockContent;
		expect(sp.height).toBe(16);
	});

	it('image and divider: omit padding/margin spread (matches legacy column shape)', () => {
		const img = createDefaultColumnItemContent('image' as never) as ImageBlockContent;
		expect((img as unknown as Record<string, unknown>).paddingTop).toBeUndefined();
		const div = createDefaultColumnItemContent('divider' as never) as DividerBlockContent;
		expect((div as unknown as Record<string, unknown>).paddingTop).toBeUndefined();
	});

	it('button: respects an override theme primary color', () => {
		const btn = createDefaultColumnItemContent('button' as never, {
			primaryColor: '#ff0000',
		} as EmailTheme) as ButtonBlockContent;
		expect(btn.backgroundColor).toBe('#ff0000');
	});

	it('createColumnItem returns a properly formed ColumnItem with id/type/content', () => {
		const item = createColumnItem('button' as never, defaultTheme);
		expect(item.id).toBeDefined();
		expect(item.type).toBe('button');
		const content = item.content as ButtonBlockContent;
		expect(content.text).toBe('Click here');
	});
});

// =============================================================================
// Bucket 4 — Extension proof: a registered third-party block flows through
// =============================================================================
describe('createDefaultColumnItemContent — third-party blocks extend the factory', () => {
	const installedTypes: BlockType[] = [];
	afterEach(() => {
		// Re-importing built-ins is not needed; we only need to remove anything we added.
		// (The block registry does not expose unregister, so we simply override on each run
		// — vitest module isolation handles test-suite cleanup.)
		installedTypes.length = 0;
	});

	it('uses the third-party createDefaultColumnItem when supplied', () => {
		registerBlock({
			type: 'custom-column-block' as BlockType,
			label: 'Custom column block',
			createDefault: () => ({ html: 'top-level' } as unknown as BlockContent),
			createDefaultColumnItem: () => ({ html: 'column-context' } as unknown as BlockContent),
			slashCommand: null,
			canBeInColumn: true,
			canBeInContainer: true,
			supportsBorderRadius: false,
			focusOnInsert: false,
		});
		installedTypes.push('custom-column-block' as BlockType);

		const content = createDefaultColumnItemContent(
			'custom-column-block' as never,
		) as unknown as { html: string };
		expect(content.html).toBe('column-context');
	});

	it('falls back to createDefault when no column-specific factory is supplied', () => {
		registerBlock({
			type: 'fallback-block' as BlockType,
			label: 'Fallback block',
			createDefault: () => ({ html: 'top-level-only' } as unknown as BlockContent),
			slashCommand: null,
			canBeInColumn: true,
			canBeInContainer: true,
			supportsBorderRadius: false,
			focusOnInsert: false,
		});
		installedTypes.push('fallback-block' as BlockType);

		const content = createDefaultColumnItemContent(
			'fallback-block' as never,
		) as unknown as { html: string };
		expect(content.html).toBe('top-level-only');
	});

	it('rejects a third-party block that opted out of canBeInColumn', () => {
		registerBlock({
			type: 'top-level-only-block' as BlockType,
			label: 'Top-level only',
			createDefault: () => ({} as BlockContent),
			slashCommand: null,
			canBeInColumn: false,
			canBeInContainer: false,
			supportsBorderRadius: false,
			focusOnInsert: false,
		});
		installedTypes.push('top-level-only-block' as BlockType);

		expect(() =>
			createDefaultColumnItemContent('top-level-only-block' as never),
		).toThrowError(/cannot be used inside a column/);
	});
});

// =============================================================================
// Bucket 5 — Failure modes
// =============================================================================
describe('createDefaultColumnItemContent — failure modes', () => {
	it('error messages name the offending type for fast diagnosis', () => {
		try {
			createDefaultColumnItemContent('does-not-exist' as never);
		} catch (err) {
			expect((err as Error).message).toContain('does-not-exist');
		}
	});

	it('returns a defensive copy: mutating the result does not corrupt the registry default', () => {
		const a = createDefaultColumnItemContent('button' as never) as ButtonBlockContent;
		a.text = 'mutated';
		const b = createDefaultColumnItemContent('button' as never) as ButtonBlockContent;
		expect(b.text).toBe('Click here');
	});
});
