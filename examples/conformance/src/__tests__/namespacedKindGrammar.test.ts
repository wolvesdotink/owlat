/**
 * The namespaced-kind grammar is written exactly once.
 *
 * `plugin.<pluginId>.<localId>` is a security boundary: the host tells core
 * kinds from plugin kinds by the prefix, and every ownership check compares the
 * plugin id embedded in it. It used to exist in eighteen places — a builder, a
 * local-id alias and a template type per bucket in `@owlat/plugin-kit`, plus
 * seven inlined template literals in codegen and the trigger seam that bypassed
 * all of them. Changing the separator would have moved some of them and silently
 * left the rest behind.
 *
 * This suite is the forcing function the finding asked for, expressed the only
 * way a static language allows: it asserts the grammar has ONE definition site,
 * and that the round trip through it holds for every reference plugin's real
 * contributions.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	parsePluginId,
	parsePluginNamespacedKind,
	PLUGIN_KIND_PREFIX,
	pluginNamespacedKind,
} from '@owlat/plugin-kit';
import { REFERENCE_GALLERY } from '../gallery';
import { REPOSITORY_ROOT } from '../repository';

/** The one module allowed to spell the grammar out. */
const DEFINITION_SITE = 'packages/plugin-kit/src/namespacedKind.ts';

/**
 * Trees that construct contributed kinds. `apps/web` is excluded: the browser
 * only ever matches the `plugin.` PREFIX (feature flags, task-flow kinds), never
 * builds a kind, and that prefix is asserted separately below.
 */
const SEARCH_ROOTS = ['packages', 'apps/api/convex', 'examples'];

/**
 * `plugin.${…}.${…}` in a VALUE position — the grammar being constructed, not
 * merely prefixed. Type-level template literals are excluded: `@owlat/shared`
 * sits below the kit in the layering and can only describe the shape, and a type
 * cannot build a wrong kind at runtime.
 */
const INLINE_GRAMMAR = /`plugin\.\$\{[^`]*\}\.\$\{/;
const TYPE_ALIAS = /^\s*(export )?type .*=/;

async function sources(): Promise<readonly string[]> {
	const files: string[] = [];
	async function walk(relative: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(join(REPOSITORY_ROOT, relative), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const child = `${relative}/${entry.name}`;
			if (entry.isDirectory()) {
				if (!['node_modules', 'dist', '_generated', '__tests__'].includes(entry.name)) {
					await walk(child);
				}
			} else if (child.endsWith('.ts') && !child.endsWith('.generated.ts')) {
				files.push(child);
			}
		}
	}
	for (const root of SEARCH_ROOTS) await walk(root);
	return files;
}

const files = await sources();

describe('namespaced kind grammar', () => {
	it('searches a real tree', async () => {
		expect(files.length).toBeGreaterThan(100);
		expect(files).toContain(DEFINITION_SITE);
	});

	it('is constructed in exactly one module', async () => {
		const offenders: string[] = [];
		for (const file of files) {
			if (file === DEFINITION_SITE) continue;
			const constructs = (await readFile(join(REPOSITORY_ROOT, file), 'utf8'))
				.split('\n')
				.some((line) => INLINE_GRAMMAR.test(line) && !TYPE_ALIAS.test(line));
			if (constructs) offenders.push(file);
		}
		expect(
			offenders,
			`these modules inline the namespaced-kind grammar instead of calling pluginNamespacedKind(): ${offenders.join(', ')}`
		).toEqual([]);
	});

	it('derives the host prefix from the same constant', () => {
		expect(PLUGIN_KIND_PREFIX).toBe('plugin.');
		expect(pluginNamespacedKind(parsePluginId('crm-sync'), 'deal-won')).toBe(
			`${PLUGIN_KIND_PREFIX}crm-sync.deal-won`
		);
	});

	it('round-trips every contributed kind of every reference plugin', () => {
		const contributions = REFERENCE_GALLERY.flatMap((entry) =>
			Object.values(entry.manifest.contributes ?? {}).flatMap((bucket) =>
				(bucket as readonly { readonly id?: unknown }[])
					.filter((item) => typeof item.id === 'string')
					.map((item) => ({ pluginId: entry.manifest.id, localId: item.id as string }))
			)
		);
		expect(contributions.length).toBeGreaterThan(0);
		for (const { pluginId, localId } of contributions) {
			const kind = pluginNamespacedKind(parsePluginId(pluginId), localId);
			expect(kind.startsWith(PLUGIN_KIND_PREFIX)).toBe(true);
			expect(parsePluginNamespacedKind(kind)).toEqual({ pluginId, localId });
		}
	});

	it('refuses a kind whose parts would not read back identically', () => {
		expect(() => pluginNamespacedKind(parsePluginId('crm-sync'), 'deal.won')).toThrow();
		expect(() => pluginNamespacedKind(parsePluginId('crm-sync'), 'Deal')).toThrow();
		expect(parsePluginNamespacedKind('plugin.crm-sync')).toBeUndefined();
		expect(parsePluginNamespacedKind('core.crm-sync.deal-won')).toBeUndefined();
		expect(parsePluginNamespacedKind('plugin.crm-sync.deal.won')).toBeUndefined();
	});
});
