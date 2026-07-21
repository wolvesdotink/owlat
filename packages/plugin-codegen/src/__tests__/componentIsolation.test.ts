import { componentsGeneric, type FunctionReference } from 'convex/server';
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { parsePluginPackageName, type BundledPlugin } from '@owlat/plugin-host';
import { parsePluginManifest } from '@owlat/plugin-kit';
import fixtureSchema from './fixtures/tier1Component/schema';
import * as fixtureRecords from './fixtures/tier1Component/records';
import { convexComponentNamespace, renderPluginComposition } from '../render';

const fixtureModules = {
	'./_generated/api.ts': async () => ({}),
	'./records.ts': async () => fixtureRecords,
};
const rootModules = { './_generated/api.ts': async () => ({}) };

describe('generated Tier-1 component isolation', () => {
	it('keeps identical component table names isolated under generated namespaces', async () => {
		const alphaNamespace = convexComponentNamespace('fixture-alpha');
		const betaNamespace = convexComponentNamespace('fixture-beta');
		const rendered = renderPluginComposition([
			fixturePlugin('fixture-alpha', 'fixture-alpha-plugin'),
			fixturePlugin('fixture-beta', 'fixture-beta-plugin'),
		]);
		expect(rendered.components).toContain(`name: "${alphaNamespace}"`);
		expect(rendered.components).toContain(`name: "${betaNamespace}"`);

		const t = convexTest(undefined, rootModules);
		t.registerComponent(alphaNamespace, fixtureSchema, fixtureModules);
		t.registerComponent(betaNamespace, fixtureSchema, fixtureModules);
		type FixtureComponent = {
			readonly records: {
				readonly put: FunctionReference<'mutation', 'public', { value: string }, string>;
				readonly list: FunctionReference<
					'query',
					'public',
					Record<never, never>,
					Array<{ value: string }>
				>;
			};
		};
		const components = componentsGeneric() as unknown as Record<string, FixtureComponent>;

		await t.mutation(components[alphaNamespace]!.records.put, { value: 'alpha' });
		expect(await t.query(components[betaNamespace]!.records.list, {})).toEqual([]);
		await t.mutation(components[betaNamespace]!.records.put, { value: 'beta' });

		const alphaRows = await t.query(components[alphaNamespace]!.records.list, {});
		const betaRows = await t.query(components[betaNamespace]!.records.list, {});
		expect(alphaRows.map((row) => row.value)).toEqual(['alpha']);
		expect(betaRows.map((row) => row.value)).toEqual(['beta']);
	});
});

function fixturePlugin(id: string, packageName: string): BundledPlugin {
	return Object.freeze({
		packageName: parsePluginPackageName(packageName),
		manifest: parsePluginManifest({
			id,
			version: '1.0.0',
			capabilities: [],
			component: { exportPath: './convex/convex.config' },
		}),
	});
}
