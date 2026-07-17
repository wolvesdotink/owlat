import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { EditorBlock } from '@owlat/shared';

/**
 * End-to-end exercise of the reference bundled block across both halves. Each
 * test runs in a fresh module graph because composition freezes the (module
 * singleton) registries.
 */
async function load() {
	vi.resetModules();
	const host = await import('../emailBlockHost');
	const reference = await import('../referenceBlock');
	const renderer = await import('@owlat/email-renderer');
	const registry = await import('../../registry/blockRegistry');
	const defaults = await import('../../defaults');
	return { host, reference, renderer, registry, defaults };
}

describe('reference bundled block', () => {
	beforeEach(() => vi.resetModules());

	it('composes through the host and renders its editor default end to end', async () => {
		const { host, reference, renderer, registry, defaults } = await load();

		host.composeHostedEmailBlocks([reference.referenceEmailBlockContribution]);

		// Editor half: the definition is registered and surfaces a slash command.
		const def = registry.getBlock(reference.REFERENCE_CALLOUT_TYPE as never);
		expect(def?.label).toBe('Callout');
		expect(
			registry.getSlashCommands().find((c) => c.id === reference.REFERENCE_CALLOUT_TYPE)?.name
		).toBe('Callout');

		// Editor default → renderer half: the block author's default content
		// flows through the full email pipeline into HTML.
		const content = def!.createDefault(defaults.defaultTheme);
		const html = renderer.renderEmailHtml([
			{ id: '1', type: reference.REFERENCE_CALLOUT_TYPE, content },
		] as unknown as EditorBlock[]);

		expect(html).toContain('Heads up');
		expect(html).toContain('border-left:4px solid #2563eb');
	});

	it('escapes untrusted author content in the rendered HTML', async () => {
		const { host, reference, renderer } = await load();
		host.composeHostedEmailBlocks([reference.referenceEmailBlockContribution]);

		const html = renderer.renderEmailHtml([
			{
				id: '1',
				type: reference.REFERENCE_CALLOUT_TYPE,
				content: { title: '<script>alert(1)</script>', body: 'a & b < c' },
			},
		] as unknown as EditorBlock[]);

		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).toContain('&lt;script&gt;');
		expect(html).toContain('a &amp; b &lt; c');
	});

	it('the reference contribution pairs both halves under one plugin id', async () => {
		const { reference } = await load();
		const { renderers, editors, pluginId } = reference.referenceEmailBlockContribution;
		expect(pluginId).toBe('owlat-reference');
		expect(renderers.map((r) => r.type)).toEqual([reference.REFERENCE_CALLOUT_TYPE]);
		expect(editors.map((e) => e.type)).toEqual([reference.REFERENCE_CALLOUT_TYPE]);
	});
});
