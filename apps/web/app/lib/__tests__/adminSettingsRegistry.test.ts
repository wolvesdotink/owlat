/**
 * The admin registry as data.
 *
 * The registry exists so Administration stops being three hub grids plus a
 * collapsed disclosure, and the assertion that keeps it honest is the
 * structural one: every PAGE under `pages/dashboard/admin` has an entry (the
 * directory is globbed, so a page added next month cannot quietly go missing
 * from the rail and the palette the way the four ramp pages did), every entry
 * points at a page that exists, every label resolves to real copy, and the gates
 * hide the right things on a deployment without AI, without plugins, or without
 * a platform admin in the room.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	ADMIN_AREAS,
	ADMIN_COMMAND_GROUP_KEY,
	ADMIN_REGISTRY,
	ADMIN_ROOT,
	adminAreaLead,
	adminAreasFor,
	adminAttentionBadges,
	adminEntryFor,
	adminRailEntryFor,
	adminTabsFor,
	buildAdminSurfaceGroups,
	reachableAdminEntries,
	type AdminEnvironment,
} from '../adminSettingsRegistry';
import { createTestI18n } from '~/__tests__/i18n';

const { t, te } = createTestI18n().global;

const here = dirname(fileURLToPath(import.meta.url));
const adminPages = join(here, '../../pages/dashboard/admin');

const FULL: AdminEnvironment = {
	isFeatureEnabled: () => true,
	isPlatformAdmin: true,
	hasPlugins: true,
	isSelfHosted: false,
};
const SELF_HOSTED: AdminEnvironment = { ...FULL, isSelfHosted: true };
const NO_AI: AdminEnvironment = {
	...FULL,
	isFeatureEnabled: (flag) => flag !== 'ai.agent' && flag !== 'ai.autonomy',
};
const NO_MAIL: AdminEnvironment = {
	...FULL,
	isFeatureEnabled: (flag) => flag !== 'postbox' && flag !== 'mail.external',
};
const WORKSPACE_ADMIN: AdminEnvironment = { ...FULL, isPlatformAdmin: false, hasPlugins: false };

/** Every `.vue` page file under `pages/dashboard/admin`. */
async function adminPageFiles(): Promise<string[]> {
	const walk = async (directory: string): Promise<string[]> => {
		const entries = await readdir(directory, { withFileTypes: true });
		const nested = await Promise.all(
			entries.map((entry) => {
				const full = join(directory, entry.name);
				if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(full);
				return entry.name.endsWith('.vue') ? [full] : [];
			})
		);
		return nested.flat();
	};
	return (await walk(adminPages)).sort();
}

/** Those pages as routes, dynamic ones (`plugins/[id]`) left out. */
async function adminRoutes(): Promise<string[]> {
	return (await adminPageFiles())
		.map((file) =>
			`${ADMIN_ROOT}/${relative(adminPages, file)
				.replace(/\\/g, '/')
				.replace(/\.vue$/, '')}`.replace(/\/index$/, '')
		)
		.filter((route) => !route.includes('['))
		.sort();
}

describe('ADMIN_REGISTRY — coverage', () => {
	it('has an entry for every admin page on disk', async () => {
		const declared = new Set(ADMIN_REGISTRY.map((entry) => entry.path));
		const undeclared = (await adminRoutes()).filter((route) => !declared.has(route));
		expect(undeclared).toEqual([]);
	});

	it('declares no entry that is not an admin page', async () => {
		const onDisk = new Set(await adminRoutes());
		const stray = ADMIN_REGISTRY.filter((entry) => !onDisk.has(entry.path)).map(
			(entry) => entry.path
		);
		expect(stray).toEqual([]);
	});

	it('uses a unique id and path per entry', () => {
		expect(new Set(ADMIN_REGISTRY.map((entry) => entry.id)).size).toBe(ADMIN_REGISTRY.length);
		expect(new Set(ADMIN_REGISTRY.map((entry) => entry.path)).size).toBe(ADMIN_REGISTRY.length);
	});

	it('assigns every entry to a declared area', () => {
		const known = new Set(ADMIN_AREAS.map((area) => area.key));
		expect(ADMIN_REGISTRY.filter((entry) => !known.has(entry.area))).toEqual([]);
	});

	it('resolves every area and entry label to real copy', () => {
		const missing = [
			...ADMIN_AREAS.map((area) => area.titleKey),
			...ADMIN_REGISTRY.map((entry) => entry.titleKey),
		].filter((key) => !te(key));
		expect(missing).toEqual([]);
	});

	it('names the ramp pages the disclosure used to hide', () => {
		const paths = reachableAdminEntries(FULL).map((entry) => entry.path);
		expect(paths).toEqual(
			expect.arrayContaining([
				`${ADMIN_ROOT}/delivery/advanced/controls`,
				`${ADMIN_ROOT}/delivery/advanced/cells`,
				`${ADMIN_ROOT}/delivery/advanced/independence`,
				`${ADMIN_ROOT}/delivery/advanced/measurement`,
			])
		);
	});

	it('renders the admin shell on every admin page', async () => {
		const wrong: string[] = [];
		for (const file of await adminPageFiles()) {
			const source = await readFile(file, 'utf8');
			if (!/layout:\s*'admin'/.test(source)) wrong.push(relative(adminPages, file));
		}
		expect(wrong).toEqual([]);
	});
});

describe('gates', () => {
	it('drops the AI pages when the agent and autonomy flags are off', () => {
		const ids = reachableAdminEntries(NO_AI).map((entry) => entry.id);
		expect(ids).not.toContain('agent');
		expect(ids).not.toContain('agentHealth');
		expect(ids).not.toContain('autonomy');
		expect(ids).not.toContain('aiReplies');
		// The on-ramp stays: this is the page where AI gets turned on.
		expect(ids).toContain('aiProvider');
	});

	it('drops team inboxes on an instance with no mail at all', () => {
		expect(reachableAdminEntries(NO_MAIL).map((entry) => entry.id)).not.toContain('inboxes');
	});

	it('keeps deployment tooling and plugin settings for whoever has them', () => {
		const platform = reachableAdminEntries(FULL).map((entry) => entry.id);
		expect(platform).toEqual(expect.arrayContaining(['system', 'backups', 'operator', 'plugins']));
		const workspace = reachableAdminEntries(WORKSPACE_ADMIN).map((entry) => entry.id);
		for (const id of ['system', 'backups', 'operator', 'plugins']) {
			expect(workspace).not.toContain(id);
		}
	});

	it('hides the operator console on a self-hosted, single-workspace deployment', () => {
		const ids = reachableAdminEntries(SELF_HOSTED).map((entry) => entry.id);
		expect(ids).not.toContain('operator');
		// The rest of the platform tooling still belongs to the platform admin.
		expect(ids).toEqual(expect.arrayContaining(['system', 'backups']));
		expect(reachableAdminEntries(FULL).map((entry) => entry.id)).toContain('operator');
	});

	it('renders the Workspace tab as the overview plus five groups', () => {
		expect(adminAreasFor(FULL).map((area) => area.key)).toEqual([
			'overview',
			'team',
			'delivery',
			'ai',
			'features',
			'system',
		]);
		// A workspace admin keeps System (general settings, desktop updates)
		// without the platform pages.
		const system = adminAreasFor(WORKSPACE_ADMIN).find((area) => area.key === 'system');
		expect(system?.entries.map((entry) => entry.id)).toEqual(['instanceGeneral', 'desktopUpdates']);
	});

	it('never renders a group with nothing in it', () => {
		const bare: AdminEnvironment = {
			isFeatureEnabled: () => false,
			isPlatformAdmin: false,
			hasPlugins: false,
			isSelfHosted: true,
		};
		for (const env of [FULL, WORKSPACE_ADMIN, bare]) {
			expect(adminAreasFor(env).filter((area) => area.entries.length === 0)).toEqual([]);
		}
	});

	it('lists every reachable, non-hidden entry in exactly one group', () => {
		const grouped = adminAreasFor(FULL).flatMap((area) => area.entries);
		expect(grouped).toEqual(reachableAdminEntries(FULL).filter((entry) => !entry.hidden));
	});

	it('keeps hidden pages out of the rail but reachable', () => {
		const listed = adminAreasFor(FULL).flatMap((area) => area.entries.map((entry) => entry.id));
		const reachable = reachableAdminEntries(FULL).map((entry) => entry.id);
		for (const id of ['rampControls', 'cells', 'independence', 'measurement', 'apiDocs']) {
			expect(listed).not.toContain(id);
			expect(reachable).toContain(id);
		}
		// One API row, one Advanced row.
		expect(listed.filter((id) => id === 'apiKeys' || id === 'apiDocs')).toEqual(['apiKeys']);
		expect(listed).toContain('advanced');
	});

	it('gives every hidden page a parent that is listed', () => {
		const listed = new Set(
			ADMIN_REGISTRY.filter((entry) => !entry.hidden).map((entry) => entry.id)
		);
		const orphans = ADMIN_REGISTRY.filter(
			(entry) => entry.hidden && (!entry.parent || !listed.has(entry.parent))
		).map((entry) => entry.id);
		expect(orphans).toEqual([]);
	});

	it('files quarantine, failed messages and activity under Email delivery', () => {
		for (const id of ['quarantine', 'failed', 'activity']) {
			expect(ADMIN_REGISTRY.find((entry) => entry.id === id)?.area).toBe('delivery');
		}
		const noInbox: AdminEnvironment = { ...FULL, isFeatureEnabled: (flag) => flag !== 'inbox' };
		const ids = reachableAdminEntries(noInbox).map((entry) => entry.id);
		expect(ids).not.toContain('quarantine');
		expect(ids).not.toContain('failed');
	});
});

describe('rail, tabs and badges', () => {
	it('stands a hidden page in for its parent row', () => {
		expect(adminRailEntryFor(`${ADMIN_ROOT}/delivery/advanced/cells`)?.id).toBe('advanced');
		expect(adminRailEntryFor(`${ADMIN_ROOT}/team/api/docs`)?.id).toBe('apiKeys');
		expect(adminRailEntryFor(`${ADMIN_ROOT}/delivery/domains`)?.id).toBe('domains');
		expect(adminRailEntryFor('/dashboard/preferences')).toBeUndefined();
	});

	it('renders the four ramp pages as tabs, and nothing else', () => {
		const tabs = adminTabsFor(`${ADMIN_ROOT}/delivery/advanced/measurement`, FULL).map(
			(entry) => entry.id
		);
		expect(tabs).toEqual(['rampControls', 'cells', 'independence', 'measurement']);
		expect(adminTabsFor(`${ADMIN_ROOT}/delivery/advanced`, FULL)).toHaveLength(4);
		// A hidden child of a parent without tabs gets none.
		expect(adminTabsFor(`${ADMIN_ROOT}/team/api/docs`, FULL)).toEqual([]);
		expect(adminTabsFor(`${ADMIN_ROOT}/delivery/domains`, FULL)).toEqual([]);
	});

	it('badges an entry only while its count is above zero', () => {
		const entries = reachableAdminEntries(FULL);
		expect(adminAttentionBadges(entries, { quarantined: 3, failed: 0 })).toEqual({
			[`${ADMIN_ROOT}/delivery/quarantine`]: 3,
		});
		expect(adminAttentionBadges(entries, {})).toEqual({});
	});

	it('leads each group with its first listed page', () => {
		expect(adminAreaLead('team')?.id).toBe('team');
		expect(adminAreaLead('delivery')?.id).toBe('delivery');
		expect(adminAreaLead('ai')?.id).toBe('aiProvider');
	});
});

describe('adminEntryFor', () => {
	it('answers for a page the registry owns and stays quiet otherwise', () => {
		expect(adminEntryFor(`${ADMIN_ROOT}/delivery/domains`)?.id).toBe('domains');
		expect(adminEntryFor('/dashboard/preferences')).toBeUndefined();
	});
});

describe('buildAdminSurfaceGroups', () => {
	const deps = {
		entries: () => reachableAdminEntries(FULL),
		t: (key: string) => t(key),
		areaTitleKey: (area: string) => `shell.admin.areas.${area}`,
		onOpen: () => {},
	};

	it('offers every reachable destination, ids namespaced away from core', () => {
		const [group] = buildAdminSurfaceGroups(deps, '');
		expect(group?.key).toBe(ADMIN_COMMAND_GROUP_KEY);
		expect(group?.items.map((item) => item.id)).toEqual(
			reachableAdminEntries(FULL).map((entry) => `admin:${entry.id}`)
		);
		// Above the core verb group (order 5), so the area you are standing in
		// leads the palette instead of falling off the capped navigation group.
		expect(group?.order).toBeLessThan(5);
	});

	it('labels a row with its page and its area', () => {
		const [group] = buildAdminSurfaceGroups(deps, '');
		const webhooks = group?.items.find((item) => item.id === 'admin:webhooks');
		expect(webhooks?.label).toBe('Webhooks');
		expect(webhooks?.subtitle).toBe('Email delivery');
	});

	it('filters on the typed query', () => {
		const [group] = buildAdminSurfaceGroups(deps, 'webh');
		expect(group?.items.map((item) => item.id)).toEqual(['admin:webhooks']);
	});

	it('offers nothing a gated-off environment cannot reach', () => {
		const [group] = buildAdminSurfaceGroups(
			{ ...deps, entries: () => reachableAdminEntries(WORKSPACE_ADMIN) },
			''
		);
		expect(group?.items.map((item) => item.id)).not.toContain('admin:operator');
	});
});
