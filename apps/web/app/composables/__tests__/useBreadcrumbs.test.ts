import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref } from 'vue';

const here = dirname(fileURLToPath(import.meta.url));
const pagesRoot = join(here, '../../pages');

const path = ref('/dashboard');
const role = ref<'owner' | 'admin' | 'editor' | null>('admin');

vi.stubGlobal('useRoute', () => ({
	get path() {
		return path.value;
	},
}));
vi.stubGlobal('useOrganizationContext', () => ({ role }));

const { useBreadcrumbs } = await import('../useBreadcrumbs');

const { breadcrumbs, setDynamicBreadcrumbs } = useBreadcrumbs();

function trailFor(route: string, viewerRole: typeof role.value = 'admin') {
	path.value = route;
	role.value = viewerRole;
	return breadcrumbs.value;
}

function labelsFor(route: string, viewerRole: typeof role.value = 'admin') {
	return trailFor(route, viewerRole).map((item) => item.label);
}

/** Every `.vue` page under `pages/dashboard/<area>`, as a concrete route path. */
async function routesUnder(area: string): Promise<string[]> {
	const root = join(pagesRoot, 'dashboard', area);
	const walk = async (directory: string): Promise<string[]> => {
		const entries = await readdir(directory, { withFileTypes: true });
		const nested = await Promise.all(
			entries.map((entry) => {
				const full = join(directory, entry.name);
				if (entry.isDirectory()) return walk(full);
				if (!entry.name.endsWith('.vue') || entry.name.startsWith('__')) return [];
				return [full];
			})
		);
		return nested.flat();
	};
	const files = await walk(root);
	return files
		.map((file) => {
			const route = `/${relative(pagesRoot, file)
				.replace(/\\/g, '/')
				.replace(/\.vue$/, '')}`
				.replace(/\/index$/, '')
				// Dynamic segments get a short concrete id so pattern configs match
				// (the slug fallback also skips segments longer than 20 chars).
				.replace(/\[{1,2}\.{0,3}([^\]]+)\]{1,2}/g, 'abc123');
			return route;
		})
		.sort();
}

describe('useBreadcrumbs', () => {
	beforeEach(() => {
		setDynamicBreadcrumbs(null);
		role.value = 'admin';
	});

	describe('route coverage', () => {
		// The slug-capitalization fallback drifts from the sidebar ('Ai Provider'
		// vs 'AI provider') and always roots the trail at 'Dashboard', so a
		// configured Administration/Preferences route never starts with it.
		it('every Administration page has a configured trail', async () => {
			const uncovered: string[] = [];
			for (const route of await routesUnder('admin')) {
				const first = labelsFor(route)[0];
				if (first !== 'Administration' && first !== 'Delivery') uncovered.push(route);
			}
			expect(uncovered).toEqual([]);
		});

		it('every Preferences page has a configured trail', async () => {
			const uncovered: string[] = [];
			for (const route of await routesUnder('preferences')) {
				if (labelsFor(route)[0] !== 'Preferences') uncovered.push(route);
			}
			expect(uncovered).toEqual([]);
		});
	});

	describe('label alignment with the sidebar / hub pages', () => {
		it.each([
			['/dashboard/admin/instance/ai-provider', 'AI provider'],
			['/dashboard/admin/instance/agent', 'AI agent'],
			['/dashboard/admin/instance/sealed-mail', 'Secure mail'],
			['/dashboard/admin/instance/channels', 'Channels'],
			['/dashboard/admin/team/connected-apps', 'Connected apps'],
			['/dashboard/admin/system', 'System & Updates'],
			['/dashboard/admin/backups', 'Backups'],
			['/dashboard/preferences/external-account', 'Connected mailboxes'],
			['/dashboard/preferences/writing-voice', 'Writing voice'],
		])('%s ends at %s', (route, page) => {
			expect(labelsFor(route).at(-1)).toBe(page);
		});

		it('nests instance pages under the Instance hub', () => {
			expect(labelsFor('/dashboard/admin/instance/features')).toEqual([
				'Administration',
				'Instance',
				'Features',
			]);
		});

		it('nests team pages under the Team & access hub', () => {
			expect(labelsFor('/dashboard/admin/team/audit')).toEqual([
				'Administration',
				'Team & access',
				'Audit Log',
			]);
		});

		// RouteConfig carries a single subsection level, so the deepest useful
		// parent (the plugin list) is the one that gets the crumb.
		it('resolves the per-plugin settings route through a pattern', () => {
			expect(labelsFor('/dashboard/admin/instance/plugins/acme-crm')).toEqual([
				'Administration',
				'Plugins',
				'Plugin settings',
			]);
		});
	});

	describe('role-aware Audience label', () => {
		it('admins keep the Audience section label', () => {
			expect(labelsFor('/dashboard/audience/topics', 'admin')).toEqual(['Audience', 'Topics']);
		});

		it('members see the sidebar label (Customers) and its landing page', () => {
			const trail = trailFor('/dashboard/audience/topics', 'editor');
			expect(trail[0]).toEqual({ label: 'Customers', href: '/dashboard/audience/contacts' });
		});

		it('members on the customer list get a single, non-duplicated crumb', () => {
			expect(trailFor('/dashboard/audience/contacts', 'editor')).toEqual([
				{ label: 'Customers', href: undefined },
			]);
		});

		it('members do not get a redundant Contacts subsection on a contact detail page', () => {
			expect(labelsFor('/dashboard/audience/contacts/abc123', 'editor')).toEqual([
				'Customers',
				'Contact Details',
			]);
			expect(labelsFor('/dashboard/audience/contacts/abc123', 'admin')).toEqual([
				'Audience',
				'Contacts',
				'Contact Details',
			]);
		});
	});

	it('dynamic overrides still win over the route table', () => {
		path.value = '/dashboard/admin/instance/general';
		setDynamicBreadcrumbs([{ label: 'Custom' }]);
		expect(breadcrumbs.value).toEqual([{ label: 'Custom' }]);
	});
});
