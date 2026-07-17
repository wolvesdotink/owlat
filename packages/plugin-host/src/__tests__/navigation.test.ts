import { describe, expect, it } from 'vitest';
import { parsePluginId } from '@owlat/plugin-kit';
import { mergeHostedNavigation, type HostedPluginNavEntry } from '../navigation';
import { PluginHostError } from '../errors';

interface Dest {
	readonly href: string;
	readonly label: string;
}

function core(href: string, enabled = true): { id: string; enabled: boolean; value: Dest } {
	return { id: href, enabled, value: { href, label: href } };
}

function plugin(
	pluginId: string,
	href: string,
	over: Partial<HostedPluginNavEntry<Dest>> = {}
): HostedPluginNavEntry<Dest> {
	return {
		pluginId: parsePluginId(pluginId),
		id: href,
		order: 0,
		enabled: true,
		value: { href, label: href },
		...over,
	};
}

const hrefs = (values: readonly Dest[]) => values.map((v) => v.href);

describe('mergeHostedNavigation', () => {
	it('keeps core entries in registration order and drops disabled ones', () => {
		const result = mergeHostedNavigation({
			core: [core('/a'), core('/b', false), core('/c')],
		});
		expect(hrefs(result)).toEqual(['/a', '/c']);
	});

	it('appends plugin entries after every core entry', () => {
		const result = mergeHostedNavigation({
			core: [core('/a'), core('/b')],
			plugins: [plugin('zeta', '/z'), plugin('alpha', '/x')],
		});
		// Core order preserved; plugins ordered by plugin id, both after core.
		expect(hrefs(result)).toEqual(['/a', '/b', '/x', '/z']);
	});

	it('orders plugin entries by plugin id, then order, then id', () => {
		const result = mergeHostedNavigation({
			core: [],
			plugins: [
				plugin('beta', '/b2', { order: 5 }),
				plugin('beta', '/b1', { order: 1 }),
				plugin('alpha', '/a-late', { order: 10 }),
				plugin('alpha', '/a-early', { order: 10, id: '/a-early' }),
			],
		});
		expect(hrefs(result)).toEqual(['/a-early', '/a-late', '/b1', '/b2']);
	});

	it('is deterministic regardless of input order (composition order cannot change output)', () => {
		const entries = [plugin('gamma', '/g'), plugin('alpha', '/a'), plugin('beta', '/b')];
		const forward = mergeHostedNavigation({ core: [core('/core')], plugins: entries });
		const reversed = mergeHostedNavigation({
			core: [core('/core')],
			plugins: [...entries].reverse(),
		});
		expect(hrefs(forward)).toEqual(hrefs(reversed));
		expect(hrefs(forward)).toEqual(['/core', '/a', '/b', '/g']);
	});

	it('lets a core entry win when a plugin claims the same id (no shadowing)', () => {
		const result = mergeHostedNavigation({
			core: [core('/dashboard/settings')],
			plugins: [plugin('evil', '/dashboard/settings', { value: { href: '/x', label: 'hijack' } })],
		});
		expect(result).toHaveLength(1);
		expect(result[0]!.label).toBe('/dashboard/settings');
	});

	it('deduplicates competing plugins by first registered wins', () => {
		const result = mergeHostedNavigation({
			core: [],
			plugins: [
				plugin('beta', '/dupe', { value: { href: '/dupe', label: 'beta' } }),
				plugin('alpha', '/dupe', { value: { href: '/dupe', label: 'alpha' } }),
			],
		});
		// alpha sorts first, so alpha wins the shared id.
		expect(result).toHaveLength(1);
		expect(result[0]!.label).toBe('alpha');
	});

	it('drops a disabled plugin entry', () => {
		const result = mergeHostedNavigation({
			core: [core('/a')],
			plugins: [plugin('beta', '/b', { enabled: false })],
		});
		expect(hrefs(result)).toEqual(['/a']);
	});

	it('deduplicates repeated core ids with first-registered-wins', () => {
		const result = mergeHostedNavigation({
			core: [
				{ id: '/a', enabled: true, value: { href: '/a', label: 'first' } },
				{ id: '/a', enabled: true, value: { href: '/a', label: 'second' } },
			],
		});
		expect(result).toHaveLength(1);
		expect(result[0]!.label).toBe('first');
	});

	it('returns a frozen array', () => {
		const result = mergeHostedNavigation({ core: [core('/a')] });
		expect(Object.isFrozen(result)).toBe(true);
	});

	it('rejects an entry without a stable id', () => {
		expect(() =>
			mergeHostedNavigation({
				core: [{ id: '  ', enabled: true, value: { href: '/a', label: 'a' } }],
			})
		).toThrow(PluginHostError);
	});

	it('rejects a plugin entry with a non-finite order', () => {
		expect(() =>
			mergeHostedNavigation({
				core: [],
				plugins: [plugin('beta', '/b', { order: Number.NaN })],
			})
		).toThrow(PluginHostError);
	});
});
