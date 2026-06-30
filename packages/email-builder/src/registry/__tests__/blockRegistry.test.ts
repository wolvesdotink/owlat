import { describe, it, expect } from 'vitest';
import {
	getAllBlocks,
	getBlock,
	getBlockTypes,
	getColumnItemTypes,
	getContainerItemTypes,
	getBorderRadiusTypes,
	getBlockLabels,
	getSlashCommands,
} from '../index';
import type { BlockType } from '../../types';

const EXPECTED_BLOCK_TYPES = [
	'text',
	'image',
	'button',
	'divider',
	'spacer',
	'columns',
	'social',
	'container',
	'hero',
	'table',
	'rawHtml',
	'video',
	'accordion',
	'menu',
	'carousel',
	'list',
	'progressBar',
] as const;

describe('blockRegistry', () => {
	describe('registration', () => {
		it('registers all 17 block types', () => {
			const types = getBlockTypes();
			expect(types).toHaveLength(17);
			for (const type of EXPECTED_BLOCK_TYPES) {
				expect(types).toContain(type);
			}
		});

		it('returns all 17 block definitions', () => {
			const blocks = getAllBlocks();
			expect(blocks).toHaveLength(17);
		});
	});

	describe('allowlist filtering', () => {
		const SIX_BASIC: BlockType[] = ['text', 'image', 'button', 'divider', 'spacer', 'columns'];

		it('getAllBlocks restricts to the allowlist when provided', () => {
			const blocks = getAllBlocks(SIX_BASIC);
			const types = blocks.map((b) => b.type).sort();
			expect(types).toEqual([...SIX_BASIC].sort());
			expect(blocks.map((b) => b.type)).not.toContain('video');
			expect(blocks.map((b) => b.type)).not.toContain('accordion');
			expect(blocks.map((b) => b.type)).not.toContain('rawHtml');
		});

		it('getAllBlocks returns all when allowlist omitted', () => {
			expect(getAllBlocks()).toHaveLength(17);
		});

		it('getSlashCommands restricts to the allowlist when provided', () => {
			const ids = getSlashCommands(SIX_BASIC).map((c) => c.id);
			// spacer has no slashCommand, so it drops out of the command list
			expect(ids).toContain('text');
			expect(ids).toContain('image');
			expect(ids).toContain('button');
			expect(ids).not.toContain('video');
			expect(ids).not.toContain('hero');
			expect(ids).not.toContain('table');
		});

		it('getSlashCommands returns the full set when allowlist omitted', () => {
			expect(getSlashCommands().length).toBeGreaterThan(getSlashCommands(SIX_BASIC).length);
		});
	});

	describe('getBlock', () => {
		it('returns a definition for each known block type', () => {
			for (const type of EXPECTED_BLOCK_TYPES) {
				const def = getBlock(type);
				expect(def).toBeDefined();
				expect(def!.type).toBe(type);
				expect(def!.label).toBeTruthy();
				expect(typeof def!.createDefault).toBe('function');
			}
		});

		it('returns undefined for unknown block type', () => {
			const def = getBlock('nonexistent' as unknown as BlockType);
			expect(def).toBeUndefined();
		});
	});

	describe('capability queries', () => {
		it('getColumnItemTypes returns types that can be in columns', () => {
			const types = getColumnItemTypes();
			// text, image, button, divider, spacer are valid column items
			expect(types).toContain('text');
			expect(types).toContain('image');
			expect(types).toContain('button');
			expect(types).toContain('divider');
			expect(types).toContain('spacer');
			// columns and container are not valid column items
			expect(types).not.toContain('columns');
			expect(types).not.toContain('container');
		});

		it('getContainerItemTypes returns types that can be in containers', () => {
			const types = getContainerItemTypes();
			expect(types.length).toBeGreaterThan(0);
			// Verify all returned types have the canBeInContainer flag
			for (const type of types) {
				const def = getBlock(type as BlockType);
				expect(def?.canBeInContainer).toBe(true);
			}
		});

		it('getBorderRadiusTypes returns types that support border-radius', () => {
			const types = getBorderRadiusTypes();
			expect(types.length).toBeGreaterThan(0);
			for (const type of types) {
				const def = getBlock(type as BlockType);
				expect(def?.supportsBorderRadius).toBe(true);
			}
		});
	});

	describe('getBlockLabels', () => {
		it('returns labels for all block types', () => {
			const labels = getBlockLabels();
			for (const type of EXPECTED_BLOCK_TYPES) {
				expect(labels[type]).toBeTruthy();
			}
		});

		it('has human-readable labels', () => {
			const labels = getBlockLabels();
			expect(labels.text).toBe('Text');
			expect(labels.image).toBe('Image');
			expect(labels.button).toBe('Button');
			expect(labels.rawHtml).toBe('HTML');
			expect(labels.progressBar).toBe('Progress');
		});
	});

	describe('getSlashCommands', () => {
		it('returns slash commands for blocks with slashCommand config', () => {
			const commands = getSlashCommands();
			expect(commands.length).toBeGreaterThan(0);
		});

		it('each command has required fields', () => {
			const commands = getSlashCommands();
			for (const cmd of commands) {
				expect(cmd.id).toBeTruthy();
				expect(cmd.name).toBeTruthy();
				expect(cmd.description).toBeTruthy();
				expect(['text', 'media', 'layout', 'components']).toContain(cmd.category);
			}
		});

		it('does not include virtual commands (h1/h2/h3)', () => {
			const commands = getSlashCommands();
			const ids = commands.map((c) => c.id);
			expect(ids).not.toContain('h1');
			expect(ids).not.toContain('h2');
			expect(ids).not.toContain('h3');
		});
	});

	describe('createDefault', () => {
		it('creates valid default content for each block type', () => {
			const theme = {
				primaryColor: '#3b82f6',
				fontFamily: 'Arial, sans-serif',
				backgroundColor: '#ffffff',
			};
			for (const type of EXPECTED_BLOCK_TYPES) {
				const def = getBlock(type)!;
				const content = def.createDefault(theme);
				expect(content).toBeDefined();
				expect(typeof content).toBe('object');
			}
		});

		it('uses theme primary color for button background', () => {
			const theme = {
				primaryColor: '#ff0000',
				fontFamily: 'Arial, sans-serif',
				backgroundColor: '#ffffff',
			};
			const def = getBlock('button')!;
			const content = def.createDefault(theme) as { backgroundColor: string };
			expect(content.backgroundColor).toBe('#ff0000');
		});
	});
});
