import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';

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

/**
 * The trail's labels are message KEYS where they come from the route registries
 * (`lib/breadcrumbRoutes` / `lib/breadcrumbPatterns` are pure modules that
 * cannot call `useI18n`), and a page-supplied dynamic crumb — a contact name, a
 * campaign title — is not a key and passes through unchanged. `Breadcrumbs.vue`
 * runs both through `t()`; so does this, or the words the sidebar is compared
 * against would be key paths.
 */
const { t } = createTestI18n().global;

function labelsFor(route: string, viewerRole: typeof role.value = 'admin') {
	return trailFor(route, viewerRole).map((item) => t(item.label));
}

/** A page that only forwards elsewhere (`definePageMeta({ redirect })`) shows no trail. */
const isRedirectStub = (source: string) => /definePageMeta\(\{\s*redirect:/.test(source);

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
	const all = await walk(root);
	const sources = await Promise.all(all.map((file) => readFile(file, 'utf8')));
	const files = all.filter((_, index) => !isRedirectStub(sources[index]!));
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
		// vs 'AI provider') and starts at the bare URL segment ('Admin'), so a
		// configured Administration/Preferences route never starts with it.
		it('every Workspace settings page has a configured trail', async () => {
			const uncovered: string[] = [];
			for (const route of await routesUnder('admin')) {
				if (labelsFor(route)[0] !== 'Workspace') uncovered.push(route);
			}
			expect(uncovered).toEqual([]);
		});

		it('every My settings page has a configured trail', async () => {
			const uncovered: string[] = [];
			for (const route of await routesUnder('preferences')) {
				if (labelsFor(route)[0] !== 'My settings') uncovered.push(route);
			}
			expect(uncovered).toEqual([]);
		});
	});

	describe('label alignment with the sidebar / hub pages', () => {
		it.each([
			['/dashboard/admin/instance/ai-provider', 'AI provider'],
			['/dashboard/admin/instance/ai-replies', 'AI replies'],
			['/dashboard/admin/instance/sealed-mail', 'Sealed mail'],
			['/dashboard/admin/instance/channels', 'Messaging channels'],
			['/dashboard/admin/team/connected-apps', 'Connected apps'],
			['/dashboard/admin/team/senders', 'Campaign senders'],
			['/dashboard/admin/delivery/transport', 'Delivery provider'],
			['/dashboard/admin/delivery/quarantine', 'Quarantine'],
			['/dashboard/admin/system', 'System & updates'],
			['/dashboard/admin/backups', 'Backups'],
			['/dashboard/preferences/external-account', 'Connected mailboxes'],
			['/dashboard/preferences/writing-voice', 'Writing voice'],
		])('%s ends at %s', (route, page) => {
			expect(labelsFor(route).at(-1)).toBe(page);
		});

		it('files a page under its Workspace group, named as the sidebar names it', () => {
			expect(labelsFor('/dashboard/admin/delivery/webhooks')).toEqual([
				'Workspace',
				'Email delivery',
				'Webhooks',
			]);
			expect(labelsFor('/dashboard/admin/team/audit')).toEqual(['Workspace', 'Team', 'Audit log']);
		});

		it('never repeats a name: a group lead page is its own crumb', () => {
			expect(labelsFor('/dashboard/admin/team')).toEqual(['Workspace', 'Team']);
			expect(labelsFor('/dashboard/admin/instance/features')).toEqual(['Workspace', 'Features']);
			expect(labelsFor('/dashboard/admin')).toEqual(['Workspace']);
		});

		it('nests a tabbed page under the sidebar row that stands for it', () => {
			expect(labelsFor('/dashboard/admin/delivery/advanced/cells')).toEqual([
				'Workspace',
				'Advanced',
				'Delivery cells',
			]);
			expect(trailFor('/dashboard/admin/delivery/advanced/cells')[1]?.href).toBe(
				'/dashboard/admin/delivery/advanced'
			);
		});

		// RouteConfig carries a single subsection level, so the deepest useful
		// parent (the plugin list) is the one that gets the crumb.
		it('resolves the per-plugin settings route through a pattern', () => {
			expect(labelsFor('/dashboard/admin/instance/plugins/acme-crm')).toEqual([
				'Workspace',
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
			expect(trail[0]).toEqual({
				label: 'shared.dashboardNavigation.sections.customers',
				href: '/dashboard/audience/contacts',
			});
			expect(t(trail[0]!.label)).toBe('Customers');
		});

		it('members on the customer list get a single, non-duplicated crumb', () => {
			expect(trailFor('/dashboard/audience/contacts', 'editor')).toEqual([
				{ label: 'shared.dashboardNavigation.sections.customers', href: undefined },
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

	/**
	 * The slug fallback printed the raw `mailMessages` id as the last crumb
	 * ("Mm_…") whenever it was short enough to survive the >20-char filter — a
	 * document id shown to a reader as a page name.
	 */
	describe('postbox message trail', () => {
		it('names the message instead of printing its document id', () => {
			expect(labelsFor('/dashboard/postbox/inbox/Mm_abc123')).toEqual([
				'Inboxes',
				'Inbox',
				'Message',
			]);
		});

		it('carries no id-looking crumb', () => {
			const id = 'Mm_k97e2h4qz1';
			expect(labelsFor(`/dashboard/postbox/archive/${id}`)).not.toContain(id);
		});

		it('links the folder crumb back to the folder it was opened from', () => {
			expect(trailFor('/dashboard/postbox/sent/Mm_abc123')[1]).toEqual({
				label: 'components.postbox.postboxLayout.folderRoles.sent',
				href: '/dashboard/postbox/sent',
			});
		});

		it('skips the folder crumb for a custom folder (its param is a raw id)', () => {
			expect(labelsFor('/dashboard/postbox/j57customfolder/Mm_abc123')).toEqual([
				'Inboxes',
				'Message',
			]);
		});

		it('reads a label list as a label, not as a message and not as its id', () => {
			expect(labelsFor('/dashboard/postbox/label/lbl_abc123')).toEqual(['Inboxes', 'Label']);
		});
	});

	/**
	 * The folder LIST route had no entry at all, so the slug fallback answered it:
	 * the trail read "Dashboard > Postbox > Inbox" — a redundant root crumb beside
	 * the home icon and an untranslated URL slug — while the message opened from
	 * that very list read "Mail > Inbox > Message".
	 */
	describe('postbox folder-list trail', () => {
		it('names the section the way the sidebar does', () => {
			expect(labelsFor('/dashboard/postbox/inbox')).toEqual(['Inboxes', 'Inbox']);
		});

		it('agrees with the message trail it opens into', () => {
			const list = labelsFor('/dashboard/postbox/sent');
			const message = labelsFor('/dashboard/postbox/sent/Mm_abc123');
			expect(message.slice(0, list.length)).toEqual(list);
		});

		it('leaves the section’s non-folder pages to their own trails', async () => {
			// Contacts/Files/Search are one-segment routes too; reading them as
			// folders would swap their page crumb for a bare, wrong "Mail".
			const { patternConfigs } = await import('~/lib/breadcrumbPatterns');
			const matches = (path: string) => patternConfigs.some((c) => c.pattern.test(path));
			expect(matches('/dashboard/postbox/inbox')).toBe(true);
			for (const page of ['contacts', 'files', 'search', 'reply-queue', 'subscriptions']) {
				expect(matches(`/dashboard/postbox/${page}`)).toBe(false);
			}
		});
	});

	/**
	 * The mailbox's own pages fell through to the slug fallback, so search read
	 * "Postbox > Search" beside folders that read "Inboxes > Inbox" (#776).
	 */
	describe('postbox page trails', () => {
		it.each([
			['/dashboard/postbox/search', 'Search'],
			['/dashboard/postbox/contacts', 'Contacts'],
			['/dashboard/postbox/files', 'Files'],
			['/dashboard/postbox/subscriptions', 'Subscriptions'],
			['/dashboard/postbox/migrate', 'Import mail'],
		])('names %s under the same section as the folders', (route, page) => {
			expect(labelsFor(route)).toEqual([
				...labelsFor('/dashboard/postbox/inbox').slice(0, 1),
				page,
			]);
		});

		it('names a custom folder list by its section, not by the URL', () => {
			expect(labelsFor('/dashboard/postbox/j57customfolderid0000000000000')).toEqual(['Inboxes']);
		});

		it('never says Postbox anywhere in the area', async () => {
			// `/dashboard/postbox` and `/reply-queue` only redirect; no trail renders.
			const redirects = new Set(['/dashboard/postbox', '/dashboard/postbox/reply-queue']);
			for (const route of await routesUnder('postbox')) {
				if (redirects.has(route)) continue;
				expect(labelsFor(route)).not.toContain('Postbox');
			}
		});
	});

	it('dynamic overrides still win over the route table', () => {
		path.value = '/dashboard/admin/instance/general';
		setDynamicBreadcrumbs([{ label: 'Custom' }]);
		expect(breadcrumbs.value).toEqual([{ label: 'Custom' }]);
	});
});
