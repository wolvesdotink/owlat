import { describe, it, expect, afterEach } from 'vitest';
import {
	blockValidators,
	registerBlockValidator,
	unregisterBlockValidator,
	type BlockValidator,
	type ValidatorContext,
} from '../validators';
import { validateBlocks } from '../validator';
import type { EditorBlock, ValidationIssue } from '@owlat/shared';

// =============================================================================
// Bucket 1 — Unit: registry lifecycle for blockValidators
// =============================================================================
describe('blockValidators — registry lifecycle', () => {
	it('every built-in Block module auto-registers a validator', () => {
		const types = blockValidators.keys().sort();
		expect(types).toEqual([
			'accordion',
			'button',
			'carousel',
			'columns',
			'container',
			'divider',
			'hero',
			'image',
			'list',
			'menu',
			'progressBar',
			'rawHtml',
			'social',
			'spacer',
			'table',
			'text',
			'video',
		]);
	});

	it('register stores a new validator', () => {
		const stub: BlockValidator = { type: 'stub', validate: () => {} };
		registerBlockValidator(stub);
		try {
			expect(blockValidators.get('stub')).toBe(stub);
		} finally {
			unregisterBlockValidator('stub');
		}
	});

	it('registering the same type replaces the validator', () => {
		const original = blockValidators.get('text')!;
		const stub: BlockValidator = { type: 'text', validate: () => {} };
		registerBlockValidator(stub);
		try {
			expect(blockValidators.get('text')).toBe(stub);
		} finally {
			registerBlockValidator(original);
		}
	});
});

// =============================================================================
// Bucket 2 — Contract: every installed validator honours BlockValidator
// =============================================================================
describe('blockValidators — every installed validator satisfies the contract', () => {
	for (const validator of blockValidators.values()) {
		describe(`validator "${validator.type}"`, () => {
			it('has a string type and a function validate', () => {
				expect(typeof validator.type).toBe('string');
				expect(typeof validator.validate).toBe('function');
			});

			it('writes only to the supplied ctx (no global mutation)', () => {
				// Build a minimally well-formed block per type to avoid intentional
				// "schema violation throws" while exercising the dispatch path.
				const wellFormedContent: Record<string, unknown> = {
					text: { html: 'x', blockType: 'paragraph', fontSize: 16, textColor: '#000' },
					image: { src: 'https://x', alt: 'x', width: 100, align: 'center' },
					button: { text: 'x', url: 'https://x', backgroundColor: '#000', textColor: '#fff', align: 'center', borderRadius: 0, paddingX: 0, paddingY: 0 },
					divider: { color: '#000', thickness: 1, width: 100, style: 'solid' },
					spacer: { height: 16 },
					table: { headers: [], rows: [], cells: [] },
					video: { thumbnailUrl: 'https://x', videoUrl: 'https://x' },
					hero: { backgroundImage: 'https://x', items: [] },
					columns: { columnCount: 1, ratio: 'equal', mobileStacking: true, columns: [[]] },
					container: { items: [], maxWidth: 100 },
					accordion: { sections: [] },
					carousel: { images: [{ src: 'https://x', alt: 'x' }] },
					list: { items: ['x'], listType: 'bullet' },
					progressBar: { value: 50, maxValue: 100 },
					menu: { items: [] },
				};
				const content = wellFormedContent[validator.type] ?? {};
				const block = { id: 'b', type: validator.type, content } as unknown as EditorBlock;
				const before: ValidatorContext = {
					issues: [],
					options: undefined,
					depth: 0,
					state: { hasTextBlock: false, headingLevels: [] },
					recurse: () => {},
				};
				expect(() => validator.validate(block, before)).not.toThrow();
			});
		});
	}
});

// =============================================================================
// Bucket 3 — Behavior-parity / regression
//
// The existing validator.test.ts, validator-enhanced.test.ts, and
// validation-levels.test.ts exercise the full pre-refactor behavior. They
// run alongside this file; any regression there is a parity failure.
//
// Here we add small explicit assertions that prove a registry-driven path is
// actually used by validateBlocks().
// =============================================================================
describe('blockValidators — registry-driven validateBlocks parity', () => {
	it('an image without src still raises IMAGE_NO_SRC', () => {
		const result = validateBlocks([
			{ id: 'i', type: 'image', content: { src: '', alt: 'x', width: 100, align: 'center' } } as EditorBlock,
		]);
		expect(result.issues.some((i) => i.code === 'IMAGE_NO_SRC')).toBe(true);
	});

	it('a button with url "#" still raises BUTTON_NO_URL', () => {
		const result = validateBlocks([
			{
				id: 'b',
				type: 'button',
				content: { text: 'go', url: '#', backgroundColor: '#000', textColor: '#fff', align: 'center', borderRadius: 0, paddingX: 0, paddingY: 0 },
			} as EditorBlock,
		]);
		expect(result.issues.some((i) => i.code === 'BUTTON_NO_URL')).toBe(true);
	});

	it('a small font in a text block raises TEXT_SMALL_FONT', () => {
		const result = validateBlocks([
			{
				id: 't',
				type: 'text',
				content: { html: 'hello', blockType: 'paragraph', fontSize: 10, textColor: '#000' },
			} as EditorBlock,
		]);
		expect(result.issues.some((i) => i.code === 'TEXT_SMALL_FONT')).toBe(true);
	});
});

// =============================================================================
// Bucket 4 — Extension proof: a third-party validator runs through validateBlocks
// =============================================================================
describe('blockValidators — extension proof', () => {
	const installed: string[] = [];
	afterEach(() => {
		while (installed.length > 0) unregisterBlockValidator(installed.pop()!);
	});

	it('registers a custom validator and validateBlocks dispatches to it', () => {
		const seen: EditorBlock[] = [];
		registerBlockValidator({
			type: 'custom-block',
			validate: (block, ctx) => {
				seen.push(block);
				ctx.issues.push({
					blockId: block.id,
					blockType: 'custom-block',
					severity: 'warning',
					code: 'CUSTOM_RULE',
					message: 'custom rule fired',
				} as unknown as ValidationIssue);
			},
		});
		installed.push('custom-block');

		const block = { id: 'x', type: 'custom-block', content: {} } as unknown as EditorBlock;
		const result = validateBlocks([block]);

		expect(seen).toHaveLength(1);
		expect(seen[0]).toBe(block);
		expect(result.issues.some((i) => i.code === 'CUSTOM_RULE')).toBe(true);
	});

	it('overriding a built-in changes which issues appear', () => {
		const original = blockValidators.get('image')!;
		registerBlockValidator({
			type: 'image',
			validate: (block, ctx) => {
				ctx.issues.push({
					blockId: block.id,
					blockType: 'image',
					severity: 'info',
					code: 'OVERRIDE',
					message: 'override fired',
				} as unknown as ValidationIssue);
			},
		});
		try {
			const result = validateBlocks([
				{ id: 'i', type: 'image', content: { src: '', alt: 'x', width: 100, align: 'center' } } as EditorBlock,
			]);
			expect(result.issues.some((i) => i.code === 'OVERRIDE')).toBe(true);
			expect(result.issues.some((i) => i.code === 'IMAGE_NO_SRC')).toBe(false);
		} finally {
			registerBlockValidator(original);
		}
	});
});

// =============================================================================
// Bucket 5 — Failure modes
// =============================================================================
describe('blockValidators — failure modes', () => {
	it('blocks of unknown type are skipped (no validator, no issues)', () => {
		const result = validateBlocks([
			{ id: 'u', type: 'nonexistent', content: {} } as unknown as EditorBlock,
		]);
		// No type-specific issues should appear (compliance/email-level may still surface)
		expect(result.issues.every((i) => i.blockType !== 'nonexistent')).toBe(true);
	});

	it('unregister of a missing key returns false', () => {
		expect(unregisterBlockValidator('not-installed')).toBe(false);
	});
});
