import { describe, it, expect } from 'vitest';
import { defineComponent, type Component } from 'vue';
import { parsePluginId } from '@owlat/plugin-kit';
import type { HostedContribution } from '@owlat/plugin-host';
import { createWidgetRegistry, resolveWidget, WidgetRegistryError } from '../registry';
import type { WidgetModule } from '../types';

const Stub: Component = defineComponent({ template: '<div />' });
const stubLoader = () => Promise.resolve(Stub);

function coreWidget(kind: string, flag?: WidgetModule['flag']): WidgetModule {
	return { kind, source: 'core', component: stubLoader, ...(flag ? { flag } : {}) };
}

function pluginContribution(pluginId: string, kind: string): HostedContribution<WidgetModule> {
	const id = parsePluginId(pluginId);
	return {
		pluginId: id,
		contributionId: kind,
		value: { kind, source: { pluginId: id }, label: `${pluginId} ${kind}`, component: stubLoader },
	};
}

const alwaysEnabled = () => true;
const alwaysDisabled = () => false;

describe('createWidgetRegistry — core modules', () => {
	it('preserves declared order and exposes lookup helpers', () => {
		const registry = createWidgetRegistry([
			coreWidget('alpha'),
			coreWidget('beta'),
			coreWidget('gamma'),
		]);

		expect(registry.kinds()).toEqual(['alpha', 'beta', 'gamma']);
		expect(registry.has('beta')).toBe(true);
		expect(registry.has('missing')).toBe(false);
		expect(registry.get('gamma')?.kind).toBe('gamma');
		expect(registry.get('missing')).toBeNull();
	});

	it('returns a frozen, immutable module list', () => {
		const registry = createWidgetRegistry([coreWidget('alpha')]);
		expect(Object.isFrozen(registry.list())).toBe(true);
		expect(Object.isFrozen(registry.list()[0])).toBe(true);
		expect(() => {
			(registry.list() as WidgetModule[]).push(coreWidget('mutant'));
		}).toThrow();
	});

	it('rejects a duplicate core kind (fails closed)', () => {
		expect(() => createWidgetRegistry([coreWidget('dup'), coreWidget('dup')])).toThrowError(
			WidgetRegistryError
		);
		try {
			createWidgetRegistry([coreWidget('dup'), coreWidget('dup')]);
		} catch (err) {
			expect((err as WidgetRegistryError).code).toBe('duplicate_core_kind');
			expect((err as WidgetRegistryError).kind).toBe('dup');
		}
	});
});

describe('createWidgetRegistry — plugin contributions', () => {
	it('appends plugin widgets after core in deterministic host order', () => {
		// Given out of order by pluginId; host ordering sorts by pluginId then id.
		const registry = createWidgetRegistry(
			[coreWidget('core_a'), coreWidget('core_b')],
			[
				pluginContribution('zeta', 'z_widget'),
				pluginContribution('acme', 'a_widget'),
				pluginContribution('acme', 'b_widget'),
			]
		);

		expect(registry.kinds()).toEqual(['core_a', 'core_b', 'a_widget', 'b_widget', 'z_widget']);
	});

	it('rejects a plugin widget that shadows a core kind', () => {
		expect(() =>
			createWidgetRegistry([coreWidget('shared')], [pluginContribution('acme', 'shared')])
		).toThrowError(WidgetRegistryError);
		try {
			createWidgetRegistry([coreWidget('shared')], [pluginContribution('acme', 'shared')]);
		} catch (err) {
			expect((err as WidgetRegistryError).code).toBe('plugin_kind_collision');
		}
	});

	it('rejects two plugins claiming the same kind', () => {
		expect(() =>
			createWidgetRegistry(
				[],
				[pluginContribution('acme', 'dash'), pluginContribution('other', 'dash')]
			)
		).toThrowError(WidgetRegistryError);
	});

	it('rejects a plugin declaring the same contribution id twice (host guard)', () => {
		// orderHostedContributions rejects duplicate contribution ids within a plugin.
		expect(() =>
			createWidgetRegistry(
				[],
				[pluginContribution('acme', 'dash'), pluginContribution('acme', 'dash')]
			)
		).toThrow();
	});
});

describe('createWidgetRegistry — contribution integrity', () => {
	function contribution(
		pluginId: string,
		contributionId: string,
		value: WidgetModule
	): HostedContribution<WidgetModule> {
		return { pluginId: parsePluginId(pluginId), contributionId, value };
	}

	function expectCode(fn: () => unknown, code: string) {
		expect(fn).toThrowError(WidgetRegistryError);
		try {
			fn();
		} catch (err) {
			expect((err as WidgetRegistryError).code).toBe(code);
		}
	}

	it('rejects a contribution whose id does not equal its widget kind', () => {
		expectCode(
			() =>
				createWidgetRegistry(
					[],
					[
						contribution('acme', 'declared_id', {
							kind: 'rendered_kind',
							source: { pluginId: parsePluginId('acme') },
							component: stubLoader,
						}),
					]
				),
			'contribution_id_mismatch'
		);
	});

	it('rejects a plugin contribution that claims source "core"', () => {
		expectCode(
			() =>
				createWidgetRegistry(
					[],
					[contribution('acme', 'w', { kind: 'w', source: 'core', component: stubLoader })]
				),
			'source_mismatch'
		);
	});

	it('rejects a contribution attributed to a different plugin', () => {
		expectCode(
			() =>
				createWidgetRegistry(
					[],
					[
						contribution('acme', 'w', {
							kind: 'w',
							source: { pluginId: parsePluginId('other') },
							component: stubLoader,
						}),
					]
				),
			'source_mismatch'
		);
	});

	it('admits a coherent contribution and preserves its provenance', () => {
		const registry = createWidgetRegistry([], [pluginContribution('acme', 'widget')]);
		const module = registry.get('widget');
		expect(module?.source).toEqual({ pluginId: 'acme' });
	});
});

describe('resolveWidget', () => {
	const registry = createWidgetRegistry([
		coreWidget('open'),
		coreWidget('gated', 'plugin.acme.beta'),
	]);

	it('resolves an ungated widget to ok regardless of flags', () => {
		expect(resolveWidget(registry, 'open', alwaysDisabled)).toEqual({
			status: 'ok',
			module: registry.get('open'),
		});
	});

	it('resolves a flagged widget to ok when its flag is enabled', () => {
		const resolution = resolveWidget(registry, 'gated', alwaysEnabled);
		expect(resolution.status).toBe('ok');
	});

	it('resolves a flagged widget to disabled when its flag is off (feature-off)', () => {
		const resolution = resolveWidget(registry, 'gated', alwaysDisabled);
		expect(resolution.status).toBe('disabled');
		expect(resolution.status === 'disabled' && resolution.module.kind).toBe('gated');
	});

	it('only consults the flag named by the widget', () => {
		const seen: string[] = [];
		resolveWidget(registry, 'gated', (flag) => {
			seen.push(flag);
			return true;
		});
		expect(seen).toEqual(['plugin.acme.beta']);
	});

	it('resolves an unregistered kind to unknown', () => {
		expect(resolveWidget(registry, 'ghost', alwaysEnabled)).toEqual({ status: 'unknown' });
	});
});

describe('createWidgetRegistry — surface-agnostic', () => {
	// The same registry composes any display surface. A thread-panel-shaped set
	// (with labels + a typed context handled at the WidgetHost boundary) composes
	// identically to the dashboard-card surface, proving the generalisation.
	it('composes a thread-panel surface with the same guarantees', () => {
		const registry = createWidgetRegistry([
			{ kind: 'crm_context', label: 'CRM', source: 'core', component: stubLoader },
			{ kind: 'related_threads', label: 'Related', source: 'core', component: stubLoader },
		]);
		expect(registry.kinds()).toEqual(['crm_context', 'related_threads']);
		expect(registry.get('crm_context')?.label).toBe('CRM');
	});
});
