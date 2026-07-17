import { describe, it, expect } from 'vitest';
import { Minus } from '@lucide/vue';
import {
	registerBlock,
	getBlock,
	finalizeBlockDefinitionRegistry,
	isBlockDefinitionRegistryFrozen,
	type BlockDefinition,
} from '../blockRegistry';
// Import through the barrel so the built-in editor modules self-register.
import {
	registerEditorModule,
	finalizeEditorModuleRegistry,
	isEditorModuleRegistryFrozen,
	editorModuleFor,
} from '../../blocks';
import type { EditorModule } from '../../blocks/_module';

/**
 * These tests freeze module-level singletons, a one-way latch. Vitest isolates
 * test files, so the freeze here does not leak into the other registry tests.
 */

const makeDefinition = (type: string): BlockDefinition =>
	({
		type,
		label: 'Frozen fixture',
		createDefault: () => ({}),
		slashCommand: null,
		canBeInColumn: false,
		canBeInContainer: false,
		supportsBorderRadius: false,
		focusOnInsert: false,
	}) as unknown as BlockDefinition;

describe('editor block registry freeze', () => {
	it('rejects block-definition registration after finalize and keeps prior entries', () => {
		expect(isBlockDefinitionRegistryFrozen()).toBe(false);

		registerBlock(makeDefinition('before-freeze'));
		expect(getBlock('before-freeze' as never)?.label).toBe('Frozen fixture');

		finalizeBlockDefinitionRegistry();
		expect(isBlockDefinitionRegistryFrozen()).toBe(true);

		expect(() => registerBlock(makeDefinition('after-freeze'))).toThrow(/frozen/);
		// The already-registered definition survives the freeze.
		expect(getBlock('before-freeze' as never)?.label).toBe('Frozen fixture');
		// The rejected registration left no residue.
		expect(getBlock('after-freeze' as never)).toBeUndefined();
	});

	it('finalizeBlockDefinitionRegistry is idempotent', () => {
		finalizeBlockDefinitionRegistry();
		finalizeBlockDefinitionRegistry();
		expect(isBlockDefinitionRegistryFrozen()).toBe(true);
	});
});

describe('editor module registry freeze', () => {
	const module = (type: string): EditorModule<'divider'> =>
		({
			type: type as 'divider',
			label: 'Module fixture',
			icon: Minus,
		}) as EditorModule<'divider'>;

	it('rejects editor-module registration after finalize', () => {
		expect(isEditorModuleRegistryFrozen()).toBe(false);
		// Built-in modules registered at import time remain present.
		expect(editorModuleFor('text')).toBeDefined();

		finalizeEditorModuleRegistry();
		expect(isEditorModuleRegistryFrozen()).toBe(true);

		expect(() => registerEditorModule(module('divider'))).toThrow(/frozen/);
		// The built-in divider module is untouched by the rejected re-registration.
		expect(editorModuleFor('divider')?.label).toBe('Divider');
	});
});
