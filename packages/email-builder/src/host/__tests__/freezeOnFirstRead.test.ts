import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { EditorBlock } from '@owlat/shared';
import type { BlockDefinition } from '../../registry/blockRegistry';
import type { HostedEmailBlockContribution } from '../emailBlockHost';

/**
 * The host loads the email packages lazily, so instead of composing at boot it
 * arms the freeze-on-first-read latch. These tests pin that the latch gives the
 * same guarantee boot composition gave: built-ins are registered, every block
 * registry is frozen by the time anything reads one, a late mutation fails
 * closed, and composition never runs twice.
 *
 * `vi.resetModules()` gives each test a fresh, unfrozen, unarmed module graph.
 */
async function load() {
	vi.resetModules();
	const latch = await import('@owlat/email-renderer/registry-latch');
	const renderer = await import('@owlat/email-renderer');
	const registry = await import('../../registry');
	const host = await import('../emailBlockHost');
	return { latch, renderer, registry, host };
}

const definition = (type: string): BlockDefinition =>
	({
		type,
		label: type,
		createDefault: () => ({}),
		slashCommand: null,
		canBeInColumn: false,
		canBeInContainer: false,
		supportsBorderRadius: false,
		focusOnInsert: false,
	}) as unknown as BlockDefinition;

const contribution = (pluginId: string, type: string): HostedEmailBlockContribution =>
	({
		pluginId,
		renderers: [{ type, render: () => `<p>${type}</p>` }],
		editors: [{ type, definition: definition(type) }],
	}) as unknown as HostedEmailBlockContribution;

const textBlock = [
	{ id: '1', type: 'text', content: { html: '<p>Hi</p>' } },
] as unknown as EditorBlock[];

describe('freeze-on-first-read latch', () => {
	beforeEach(() => vi.resetModules());

	it('does nothing while unarmed: reads leave the registries open', async () => {
		const { renderer, registry, host } = await load();
		registry.getAllBlocks();
		renderer.renderEmailHtml(textBlock);
		expect(host.areEmailBlockRegistriesFrozen()).toBe(false);
		expect(() => registry.registerBlock(definition('late'))).not.toThrow();
	});

	it('freezes all four registries on the first editor read, after the built-ins registered', async () => {
		const { latch, renderer, registry, host } = await load();
		latch.armEmailBlockRegistryFreeze();
		expect(host.areEmailBlockRegistriesFrozen()).toBe(false);

		expect(registry.getBlock('text')).toBeDefined();

		expect(host.areEmailBlockRegistriesFrozen()).toBe(true);
		expect(renderer.moduleFor('text')).toBeDefined();
		expect(() => registry.registerBlock(definition('late'))).toThrow(/frozen/);
		expect(() => renderer.registerBlock('late', () => '')).toThrow(/frozen/);
	});

	it('freezes all four registries on the first render', async () => {
		const { latch, renderer, host } = await load();
		latch.armEmailBlockRegistryFreeze();

		expect(renderer.renderEmailHtml(textBlock)).toContain('Hi');

		expect(host.areEmailBlockRegistriesFrozen()).toBe(true);
	});

	it('refuses a composition that arrives after the first read', async () => {
		const { latch, registry, host } = await load();
		latch.armEmailBlockRegistryFreeze();
		registry.getAllBlocks();

		expect(() => host.composeHostedEmailBlocks([])).toThrow(
			expect.objectContaining({ code: 'registries_frozen' })
		);
	});

	it('lets an armed host compose contributions explicitly before the first read', async () => {
		const { latch, renderer, registry, host } = await load();
		latch.armEmailBlockRegistryFreeze();

		const composed = host.composeHostedEmailBlocks([contribution('acme', 'acme-note')]);

		expect(composed.map((block) => block.type)).toEqual(['acme-note']);
		expect(host.areEmailBlockRegistriesFrozen()).toBe(true);
		expect(registry.getBlock('acme-note')?.label).toBe('acme-note');
		expect(renderer.getRegisteredBlocks()).toContain('acme-note');
	});

	it('re-arms after a failed composition so the next read still freezes', async () => {
		const { latch, registry, host } = await load();
		latch.armEmailBlockRegistryFreeze();

		expect(() => host.composeHostedEmailBlocks([contribution('acme', 'text')])).toThrow(
			expect.objectContaining({ code: 'reserved_block_type' })
		);
		expect(host.areEmailBlockRegistriesFrozen()).toBe(false);
		expect(latch.isEmailBlockRegistryFreezeArmed()).toBe(true);

		registry.getAllBlocks();
		expect(host.areEmailBlockRegistriesFrozen()).toBe(true);
	});

	it('freezes a registry loaded after the latch fired on its own first read', async () => {
		vi.resetModules();
		const latch = await import('@owlat/email-renderer/registry-latch');
		const renderer = await import('@owlat/email-renderer');
		latch.armEmailBlockRegistryFreeze();
		renderer.renderEmailHtml(textBlock);
		expect(renderer.isBlockRegistryFrozen()).toBe(true);
		expect(renderer.isRegistryFinalized()).toBe(true);

		// The builder loads later (a lazily imported chunk): its built-ins still
		// register, and its registries freeze on their first read.
		const registry = await import('../../registry');
		expect(registry.isEditorModuleRegistryFrozen()).toBe(false);
		expect(registry.getAllBlocks().length).toBeGreaterThan(0);
		expect(registry.isEditorModuleRegistryFrozen()).toBe(true);
		expect(registry.isBlockDefinitionRegistryFrozen()).toBe(true);
	});
});
