import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { EditorBlock } from '@owlat/shared';
import type { BlockDefinition } from '../../registry/blockRegistry';
import type {
	HostedEmailBlockContribution,
	HostedEmailBlockRenderer,
	HostedEmailBlockEditor,
} from '../emailBlockHost';

/**
 * The block registries are module-level one-way latches. `vi.resetModules()`
 * before each test gives every test a fresh, unfrozen module graph so the
 * freeze in one test cannot leak into the next.
 */
async function loadHost() {
	vi.resetModules();
	const host = await import('../emailBlockHost');
	const renderer = await import('@owlat/email-renderer');
	const registry = await import('../../registry/blockRegistry');
	const kit = await import('@owlat/plugin-kit');
	return { host, renderer, registry, kit };
}

const rendererHalf = (type: string, marker: string): HostedEmailBlockRenderer => ({
	type,
	render: (content) => {
		const c = content as { label?: string };
		return `<div class="${marker}">${c.label ?? ''}</div>`;
	},
});

const editorHalf = (type: string, label: string): HostedEmailBlockEditor => ({
	type,
	// The icon is a Vue component in production; a stub object is enough here.
	definition: {
		type,
		label,
		createDefault: () => ({ label }),
		slashCommand: {
			name: label,
			description: `Insert a ${label}`,
			icon: {},
			category: 'components',
		},
		canBeInColumn: false,
		canBeInContainer: false,
		supportsBorderRadius: false,
		focusOnInsert: false,
	} as unknown as BlockDefinition,
});

const contribution = (
	pluginId: string,
	renderers: HostedEmailBlockRenderer[],
	editors: HostedEmailBlockEditor[]
): HostedEmailBlockContribution =>
	({ pluginId, renderers, editors }) as unknown as HostedEmailBlockContribution;

describe('composeHostedEmailBlocks — happy path', () => {
	beforeEach(() => vi.resetModules());

	it('registers both halves and renders the block end to end', async () => {
		const { host, renderer, registry } = await loadHost();

		const composed = host.composeHostedEmailBlocks([
			contribution(
				'acme',
				[rendererHalf('acme-badge', 'badge')],
				[editorHalf('acme-badge', 'Badge')]
			),
		]);

		// Renderer half: the block renders through the full email pipeline.
		const html = renderer.renderEmailHtml([
			{ id: '1', type: 'acme-badge', content: { label: 'Hello' } },
		] as unknown as EditorBlock[]);
		expect(html).toContain('class="badge"');
		expect(html).toContain('Hello');

		// Editor half: the definition is retrievable and surfaces its slash command.
		const def = registry.getBlock('acme-badge' as never);
		expect(def?.label).toBe('Badge');
		expect(registry.getSlashCommands().some((c) => c.id === 'acme-badge')).toBe(true);

		// Both halves belong to the composed result.
		expect(composed).toHaveLength(1);
		expect(composed[0]).toMatchObject({ pluginId: 'acme', type: 'acme-badge' });

		// Registries are frozen after composition.
		expect(host.areEmailBlockRegistriesFrozen()).toBe(true);
	});

	it('orders composed blocks deterministically by plugin then type', async () => {
		const { host } = await loadHost();
		const composed = host.composeHostedEmailBlocks([
			contribution('zeta', [rendererHalf('zeta-b', 'zb')], [editorHalf('zeta-b', 'ZB')]),
			contribution(
				'alpha',
				[rendererHalf('alpha-y', 'ay'), rendererHalf('alpha-x', 'ax')],
				[editorHalf('alpha-y', 'AY'), editorHalf('alpha-x', 'AX')]
			),
		]);
		expect(composed.map((b) => `${b.pluginId}:${b.type}`)).toEqual([
			'alpha:alpha-x',
			'alpha:alpha-y',
			'zeta:zeta-b',
		]);
	});

	it('freezes the registries even with no plugin blocks', async () => {
		const { host } = await loadHost();
		expect(host.areEmailBlockRegistriesFrozen()).toBe(false);
		host.composeHostedEmailBlocks([]);
		expect(host.areEmailBlockRegistriesFrozen()).toBe(true);
	});
});

describe('composeHostedEmailBlocks — rejections', () => {
	beforeEach(() => vi.resetModules());

	it('rejects a renderer with no matching editor half', async () => {
		const { host } = await loadHost();
		expect(() =>
			host.composeHostedEmailBlocks([contribution('acme', [rendererHalf('lonely', 'x')], [])])
		).toThrow(host.EmailBlockCompositionError);
		try {
			host.composeHostedEmailBlocks([contribution('acme', [rendererHalf('lonely', 'x')], [])]);
		} catch (err) {
			expect((err as InstanceType<typeof host.EmailBlockCompositionError>).code).toBe(
				'renderer_without_editor'
			);
		}
		// A rejected composition must not have frozen the registries.
		expect(host.areEmailBlockRegistriesFrozen()).toBe(false);
	});

	it('rejects an editor with no matching renderer half', async () => {
		const { host } = await loadHost();
		try {
			host.composeHostedEmailBlocks([contribution('acme', [], [editorHalf('orphan', 'Orphan')])]);
			throw new Error('expected rejection');
		} catch (err) {
			expect((err as InstanceType<typeof host.EmailBlockCompositionError>).code).toBe(
				'editor_without_renderer'
			);
		}
	});

	it('rejects overriding a built-in block type', async () => {
		const { host } = await loadHost();
		try {
			host.composeHostedEmailBlocks([
				contribution('acme', [rendererHalf('text', 'x')], [editorHalf('text', 'Text')]),
			]);
			throw new Error('expected rejection');
		} catch (err) {
			expect((err as InstanceType<typeof host.EmailBlockCompositionError>).code).toBe(
				'reserved_block_type'
			);
		}
	});

	it('rejects two plugins claiming the same block type', async () => {
		const { host } = await loadHost();
		try {
			host.composeHostedEmailBlocks([
				contribution('one', [rendererHalf('shared', 'a')], [editorHalf('shared', 'A')]),
				contribution('two', [rendererHalf('shared', 'b')], [editorHalf('shared', 'B')]),
			]);
			throw new Error('expected rejection');
		} catch (err) {
			expect((err as InstanceType<typeof host.EmailBlockCompositionError>).code).toBe(
				'duplicate_block_type'
			);
		}
	});

	it('rejects a duplicate renderer type within one plugin', async () => {
		const { host } = await loadHost();
		try {
			host.composeHostedEmailBlocks([
				contribution(
					'acme',
					[rendererHalf('dupe', 'a'), rendererHalf('dupe', 'b')],
					[editorHalf('dupe', 'Dupe')]
				),
			]);
			throw new Error('expected rejection');
		} catch (err) {
			expect((err as InstanceType<typeof host.EmailBlockCompositionError>).code).toBe(
				'duplicate_block_type'
			);
		}
	});
});

describe('composeHostedEmailBlocks — late registration fails closed', () => {
	beforeEach(() => vi.resetModules());

	it('rejects a second composition once frozen', async () => {
		const { host } = await loadHost();
		host.composeHostedEmailBlocks([]);
		try {
			host.composeHostedEmailBlocks([
				contribution('late', [rendererHalf('late-block', 'l')], [editorHalf('late-block', 'Late')]),
			]);
			throw new Error('expected rejection');
		} catch (err) {
			expect((err as InstanceType<typeof host.EmailBlockCompositionError>).code).toBe(
				'registries_frozen'
			);
		}
	});

	it('rejects late direct registration on both halves after freeze', async () => {
		const { host, renderer, registry } = await loadHost();
		host.composeHostedEmailBlocks([]);
		expect(() => renderer.registerBlock('late', () => '<div></div>')).toThrow(/frozen/);
		expect(() => registry.registerBlock({ type: 'late' } as unknown as BlockDefinition)).toThrow(
			/frozen/
		);
	});
});
