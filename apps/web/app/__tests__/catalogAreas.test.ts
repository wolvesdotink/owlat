// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { areasForPath } from '~~/i18n/areaRuntime';
import {
	BOOT_NAMESPACES,
	htmlMessageKeys,
	keyReferences,
	leafKeys,
	pageArea,
	planCatalogAreas,
	splitCatalog,
	type CatalogPlan,
} from '~~/i18n/catalogAreas';
import { completeCatalogs, type MessageCatalog } from '~~/i18n/completeCatalogs';
import { componentKey, listSourceFiles, type SourceGraph } from '~~/i18n/sourceGraph';
import { planSourceCatalog, SOURCE_ROOTS } from '~~/i18n/writeCatalogs';

/**
 * A build cuts the app catalog into a boot catalog and route-area chunks (plan
 * 3.4). A message that lands in the wrong chunk renders as its key path on some
 * screen, so these pin the cut: on a synthetic app where every case is known,
 * and on the real one, where the union must be the source catalog and every
 * key the always-on code names must ship at boot.
 */

function deepMerge(target: MessageCatalog, source: MessageCatalog): MessageCatalog {
	for (const [key, value] of Object.entries(source)) {
		const existing = target[key];
		if (typeof value === 'object' && typeof existing === 'object') deepMerge(existing, value);
		else target[key] = typeof value === 'object' ? deepMerge({}, value) : value;
	}
	return target;
}

describe('pageArea', () => {
	it('gives each dashboard section and each top-level page its own area', () => {
		expect(pageArea('dashboard/admin/team/index.vue')).toEqual({
			path: '/dashboard/admin',
			exact: false,
			area: 'dashboard-admin',
		});
		expect(pageArea('dashboard/answer.vue')?.area).toBe('dashboard-answer');
		expect(pageArea('setup/index.vue')).toEqual({ path: '/setup', exact: false, area: 'setup' });
		expect(pageArea('terms.vue')).toEqual({ path: '/terms', exact: false, area: 'terms' });
	});

	it('keeps the dashboard home to its own path', () => {
		expect(pageArea('dashboard/index.vue')).toEqual({
			path: '/dashboard',
			exact: true,
			area: 'dashboard',
		});
	});

	it('ships the auth pages, the root page and dynamic area segments at boot', () => {
		expect(pageArea('auth/login.vue')).toBeNull();
		expect(pageArea('index.vue')).toBeNull();
		expect(pageArea('[slug].vue')).toBeNull();
		expect(pageArea('dashboard/[id].vue')).toBeNull();
		expect(pageArea('dashboard.vue')).toBeNull();
	});
});

describe('componentKey', () => {
	it('names a component the way Nuxt registers it', () => {
		expect(componentKey('postbox/PostboxReader.vue')).toBe('postboxreader');
		expect(componentKey('agent-tasks/TaskCardRenderer.vue')).toBe('agenttaskstaskcardrenderer');
		expect(componentKey('shell/index.vue')).toBe('shell');
		expect(componentKey('AppCommandPalette.vue')).toBe('appcommandpalette');
		expect(componentKey('ui/Button.client.vue')).toBe('uibutton');
	});
});

describe('keyReferences', () => {
	const catalog: MessageCatalog = { a: { b: { c: 'C' } }, d: { e: 'E' } };

	it('tells a full key from the stem of a key built at runtime', () => {
		const refs = keyReferences(catalog, "t('a.b.c'); t(`a.b.${x}`); obj.a.b.c; 'x.y';");
		expect([...refs.leaves]).toEqual(['a.b.c']);
		expect([...refs.prefixes]).toEqual(['a.b']);
	});
});

describe('htmlMessageKeys', () => {
	it('flags a message carrying markup and leaves placeholders and arrows alone', () => {
		const catalog: MessageCatalog = {
			a: { bold: 'Hi <b>there</b>', link: '<a href="/x">x</a>' },
			b: { placeholder: 'Hi {name}', arrow: 'a -> b', lessThan: '1 < 2' },
		};
		expect(htmlMessageKeys(catalog)).toEqual(['a.bold', 'a.link']);
	});
});

describe('planCatalogAreas on a known app', () => {
	const app = '/app';
	const f = (path: string) => `${app}/${path}`;
	const sources: Record<string, string> = {
		[f('layouts/default.vue')]: "t('common.save'); t('components.nav.title')",
		[f('components/nav/Nav.vue')]: "t('components.nav.link')",
		[f('pages/auth/login.vue')]: "t('dashboard.login.title')",
		[f('pages/dashboard/admin/index.vue')]:
			"t('dashboard.admin.title'); t('components.table.head')",
		[f('pages/dashboard/send/index.vue')]: "t('dashboard.send.title'); t('components.table.head')",
		[f('pages/dashboard/send/built.vue')]: 't(`dashboard.send.status.${s}`)',
		[f('components/table/Table.vue')]: "t('components.table.cell')",
		[f('components/orphan/Orphan.vue')]: "t('components.orphan.text')",
	};
	const edges: Record<string, string[]> = {
		[f('layouts/default.vue')]: [f('components/nav/Nav.vue')],
		[f('pages/dashboard/admin/index.vue')]: [f('components/table/Table.vue')],
		[f('pages/dashboard/send/index.vue')]: [f('components/table/Table.vue')],
	};
	const graph: SourceGraph = {
		sources: new Map(Object.entries(sources)),
		edges: new Map(Object.keys(sources).map((file) => [file, new Set(edges[file] ?? [])])),
	};
	const catalog: MessageCatalog = {
		common: { save: 'Save' },
		shared: { thing: 'Shared thing' },
		components: {
			nav: { title: 'Nav', link: 'Link' },
			table: { head: 'Head', cell: 'Cell' },
			orphan: { text: 'Orphan' },
		},
		dashboard: {
			login: { title: 'Sign in' },
			admin: { title: 'Admin', backend: 'From the backend', unused: 'Unused' },
			send: { title: 'Send', status: { queued: 'Queued' } },
		},
	};
	const plan = planCatalogAreas({
		catalog,
		graph,
		appDir: app,
		layerDirs: [],
		externalSources: ["throw new Error('dashboard.admin.backend')"],
	});
	const areas = (key: string) => [...(plan.areasByKey.get(key) ?? [])].sort();

	it('ships at boot what layouts, their components and auth pages name', () => {
		for (const key of [
			'common.save',
			'components.nav.title',
			'components.nav.link',
			'dashboard.login.title',
		]) {
			expect(areas(key), key).toEqual([]);
		}
	});

	it('puts a page’s messages, and its components’, in the page’s area', () => {
		expect(areas('dashboard.admin.title')).toEqual(['dashboard-admin']);
		expect(areas('dashboard.send.title')).toEqual(['dashboard-send']);
	});

	it('puts a message two areas reach in both chunks', () => {
		expect(areas('components.table.head')).toEqual(['dashboard-admin', 'dashboard-send']);
		expect(areas('components.table.cell')).toEqual(['dashboard-admin', 'dashboard-send']);
	});

	it('ships at boot a runtime-built namespace, a backend key, an unnamed key and a shared namespace', () => {
		expect(areas('dashboard.send.status.queued')).toEqual([]);
		expect(areas('dashboard.admin.backend')).toEqual([]);
		expect(areas('dashboard.admin.unused')).toEqual([]);
		expect(areas('components.orphan.text')).toEqual([]);
		expect(areas('shared.thing')).toEqual([]);
	});

	it('routes only the areas that have a chunk', () => {
		expect(plan.routes.map((route) => route.area)).toEqual(['dashboard-admin', 'dashboard-send']);
	});
});

describe('the real catalogs', () => {
	const catalogs = completeCatalogs();
	const en = catalogs.get('en')!;
	const plan = planSourceCatalog(en) as CatalogPlan;
	const splits = new Map(
		[...catalogs].map(([code, catalog]) => [code, splitCatalog(catalog, plan)])
	);

	it('is split at all', () => {
		expect(plan).not.toBeNull();
		expect(plan.routes.map((route) => route.area)).toEqual(
			expect.arrayContaining(['dashboard-admin', 'dashboard-postbox', 'setup'])
		);
	});

	it.each(['en', 'de'])(
		'puts every %s message back together from the boot catalog and the chunks',
		(code) => {
			const split = splits.get(code)!;
			const union = deepMerge({}, split.boot);
			for (const chunk of Object.values(split.areas)) deepMerge(union, chunk);
			expect(union).toEqual(catalogs.get(code));
		}
	);

	it('ships no HTML in a chunk (the build rejects it as the i18n compiler would)', () => {
		for (const split of splits.values()) {
			for (const chunk of Object.values(split.areas)) expect(htmlMessageKeys(chunk)).toEqual([]);
		}
	});

	it('never carries a boot message in a chunk too', () => {
		const boot = new Set(leafKeys(splits.get('en')!.boot));
		for (const [area, chunk] of Object.entries(splits.get('en')!.areas)) {
			expect(
				leafKeys(chunk).filter((key) => boot.has(key)),
				area
			).toEqual([]);
		}
	});

	it('ships the shared namespaces whole at boot', () => {
		const boot = new Set(leafKeys(splits.get('en')!.boot));
		const shared = leafKeys(en).filter((key) =>
			BOOT_NAMESPACES.some((ns) => key === ns || key.startsWith(`${ns}.`))
		);
		expect(shared.length).toBeGreaterThan(1000);
		expect(shared.filter((key) => !boot.has(key))).toEqual([]);
	});

	it('ships at boot every key the layouts, shell, auth pages, middleware and plugins name', () => {
		const { appDir } = SOURCE_ROOTS;
		const alwaysOn = [
			...['layouts', 'components/shell', 'pages/auth', 'middleware', 'plugins'].flatMap((dir) =>
				listSourceFiles(join(appDir, dir))
			),
			join(appDir, 'app.vue'),
			join(appDir, 'error.vue'),
		];
		const boot = new Set(leafKeys(splits.get('en')!.boot));
		const named = alwaysOn.flatMap((file) => {
			const refs = keyReferences(en, readFileSync(file, 'utf8'));
			return [...refs.leaves].map((key) => `${file.slice(appDir.length)}: ${key}`);
		});
		// About 170 today; a handful would mean the scan broke.
		expect(named.length).toBeGreaterThan(100);
		expect(named.filter((entry) => !boot.has(entry.split(': ')[1]!))).toEqual([]);
	});

	it('loads the admin console’s copy with the admin console', () => {
		const admin = splits.get('en')!.areas['dashboard-admin']!;
		expect(leafKeys(admin).some((key) => key.startsWith('dashboard.admin.'))).toBe(true);
		expect(areasForPath(plan.routes, '/dashboard/admin/team')).toEqual(['dashboard-admin']);
		expect(areasForPath(plan.routes, '/auth/login')).toEqual([]);
	});

	it('keeps the boot catalog well under half of the source catalog', () => {
		const bytes = (value: unknown) => JSON.stringify(value).length;
		expect(bytes(splits.get('en')!.boot)).toBeLessThan(bytes(en) / 2);
	});
});
