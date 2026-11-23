/**
 * The palette's route coverage, projected out of the breadcrumb table.
 *
 * The failure this suite exists to catch is a silent one: the admin leaves
 * ("AI provider", "Webhooks", "Ramp controls") are reachable from a hub page and
 * from nowhere else, so a palette that quietly stops listing them looks fine and
 * is unusable by keyboard. It also pins the two rules that make feeding a
 * *breadcrumb* table into navigation safe — the sidebar's gates are re-applied,
 * and anything the sidebar already lists keeps its own wording.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FEATURE_FLAG_KEYS,
	getDefaultFlags,
	resolveFlags,
	type FeatureFlagKey,
	type FeatureFlagState,
} from '@owlat/shared/featureFlags';
import type { NavigationEnvironment } from '../dashboardNavigationCore';
import { routePaletteTargets } from '../commandPaletteRoutes';
import { ADMIN_AREAS, adminEntryFor, type AdminEnvironment } from '../adminSettingsRegistry';
import { adminControlTargets } from '../adminSettingsControls';
import { buildNavigationSections } from '../dashboardNavigation';
import { quickCreateEntriesFor } from '../quickCreate';
import { ROUTE_FEATURE_RULES, blockedFeature } from '../routeFeatureGates';
import { settingsControlTargets } from '../settingsRegistry';
import { createTestI18n } from '~/__tests__/i18n';
import { ShieldCheckIcon, UsersIcon } from '@coolicons/vue';

const { t } = createTestI18n().global;

function env(overrides: Partial<NavigationEnvironment> = {}): NavigationEnvironment {
	return {
		isFeatureEnabled: () => true,
		isDesktop: false,
		role: 'admin',
		...overrides,
	};
}

/** A platform admin on a deployment that has every admin page, the ramp included. */
const ADMIN: AdminEnvironment = {
	isFeatureEnabled: () => true,
	isPlatformAdmin: true,
	hasPlugins: true,
	hasRampStarted: true,
};

function hrefs(
	environment = env(),
	known: Iterable<string> = [],
	admin: AdminEnvironment = ADMIN
): string[] {
	return routePaletteTargets(environment, new Set(known), admin).map((target) => target.href);
}

describe('routePaletteTargets', () => {
	it('reaches the admin leaves the sidebar hides behind a hub', () => {
		const reachable = hrefs();
		expect(reachable).toEqual(
			expect.arrayContaining([
				'/dashboard/admin/instance/ai-provider',
				'/dashboard/admin/delivery/webhooks',
				'/dashboard/admin/delivery/advanced/controls',
				'/dashboard/admin/team/audit',
			])
		);
	});

	it('labels a leaf with its page crumb and the level above it', () => {
		const target = routePaletteTargets(env(), new Set(), ADMIN).find(
			(entry) => entry.href === '/dashboard/audience/segments'
		);
		expect(target).toMatchObject({
			labelKey: 'shared.breadcrumbRoutes.pages.segments',
			contextKey: 'shared.breadcrumbRoutes.sections.audience',
			icon: UsersIcon,
		});
	});

	it('names an admin page with the title and area its own rail prints', () => {
		const targets = routePaletteTargets(env(), new Set(), ADMIN);
		for (const target of targets.filter((entry) => entry.href.startsWith('/dashboard/admin'))) {
			const entry = adminEntryFor(target.href);
			if (!entry) continue;
			const area = ADMIN_AREAS.find((candidate) => candidate.key === entry.area)!;
			expect(target.labelKey, target.href).toBe(entry.titleKey);
			expect(target.contextKey, target.href).toBe(area.titleKey);
		}
		const webhooks = targets.find((entry) => entry.href === '/dashboard/admin/delivery/webhooks');
		expect(webhooks).toMatchObject({
			labelKey: 'shared.breadcrumbRoutes.pages.webhooks',
			// The Workspace group the page sits in, as the Settings sidebar names it.
			contextKey: 'shell.admin.areas.delivery',
			icon: ShieldCheckIcon,
		});
	});

	it('gives a section root no context line', () => {
		const target = routePaletteTargets(env(), new Set(), ADMIN).find(
			(entry) => entry.href === '/dashboard'
		);
		expect(target?.labelKey).toBe('shared.breadcrumbRoutes.sections.dashboard');
		expect(target?.contextKey).toBeUndefined();
	});

	it('files campaigns, automations and templates under Marketing, not Send', () => {
		const targets = routePaletteTargets(env(), new Set(), ADMIN);
		for (const href of ['/dashboard/campaigns', '/dashboard/automations', '/dashboard/send']) {
			const target = targets.find((entry) => entry.href === href);
			expect(target?.contextKey, href).toBe('shared.breadcrumbRoutes.sections.marketing');
			expect(t(target!.contextKey!)).toBe('Marketing');
		}
	});

	it('names transactional emails by their own section, not Marketing', () => {
		const target = routePaletteTargets(env(), new Set(), ADMIN).find(
			(entry) => entry.href === '/dashboard/send/transactional'
		);
		expect(t(target!.labelKey)).toBe('Emails');
		expect(t(target!.contextKey!)).toBe('Transactional');
	});

	it('takes Transactional with its feature flag', () => {
		const reachable = hrefs(env({ isFeatureEnabled: (flag) => flag !== 'transactional' }));
		expect(reachable.filter((href) => href.startsWith('/dashboard/send/transactional'))).toEqual(
			[]
		);
		expect(reachable).toContain('/dashboard/send');
	});

	it('renders every derived key as words, never as a key path', () => {
		for (const target of routePaletteTargets(env(), new Set(), ADMIN)) {
			expect(t(target.labelKey)).not.toBe(target.labelKey);
			if (target.contextKey) expect(t(target.contextKey)).not.toBe(target.contextKey);
		}
	});

	it('never offers an admin destination to a member', () => {
		const reachable = hrefs(env({ role: 'editor' }));
		expect(reachable.filter((href) => href.startsWith('/dashboard/admin'))).toEqual([]);
		// …while the pages a member does reach are still there.
		expect(reachable).toContain('/dashboard');
	});

	it('takes Visualizations with the admin role and its feature flag, as the page does', () => {
		const href = '/dashboard/visualizations';
		expect(hrefs()).toContain(href);
		expect(hrefs(env({ role: 'editor' }))).not.toContain(href);
		expect(hrefs(env({ isFeatureEnabled: (flag) => flag !== 'ai.visualizations' }))).not.toContain(
			href
		);
	});

	it('takes a section with its feature flag', () => {
		const reachable = hrefs(env({ isFeatureEnabled: (flag) => flag !== 'campaigns' }));
		expect(reachable.filter((href) => href.startsWith('/dashboard/campaigns'))).toEqual([]);
		expect(reachable).toContain('/dashboard/admin/instance/ai-provider');
	});

	it('leaves out the ramp pages until the ramp has started, as the rail does', () => {
		const ramp = (href: string) => href.startsWith('/dashboard/admin/delivery/advanced');
		expect(hrefs(env(), [], { ...ADMIN, hasRampStarted: false }).filter(ramp)).toEqual([]);
		expect(hrefs().filter(ramp)).toEqual([
			'/dashboard/admin/delivery/advanced/controls',
			'/dashboard/admin/delivery/advanced/cells',
			'/dashboard/admin/delivery/advanced/independence',
			'/dashboard/admin/delivery/advanced/measurement',
		]);
	});

	it('leaves out the deployment tooling for a workspace admin, as the rail does', () => {
		const reachable = hrefs(env(), [], { ...ADMIN, isPlatformAdmin: false });
		for (const href of [
			'/dashboard/admin/system',
			'/dashboard/admin/backups',
			'/dashboard/admin/operator',
		]) {
			expect(reachable).not.toContain(href);
			expect(hrefs()).toContain(href);
		}
	});

	it('leaves Preferences to the settings registry', () => {
		expect(hrefs().filter((href) => href.startsWith('/dashboard/preferences'))).toEqual([]);
	});

	it('drops the routes the sidebar already contributes', () => {
		const known = ['/dashboard/admin', '/dashboard/admin/delivery'];
		const reachable = hrefs(env(), known);
		expect(reachable).not.toContain('/dashboard/admin');
		expect(reachable).not.toContain('/dashboard/admin/delivery');
		expect(reachable).toContain('/dashboard/admin/delivery/webhooks');
	});
});

/**
 * One destination, one row. A page that only redirects lands where
 * another row already goes, so the palette never offers it.
 */
describe('palette targets and redirect-only pages', () => {
	const pages = join(dirname(fileURLToPath(import.meta.url)), '../../pages');
	function pageSource(href: string): string | null {
		for (const candidate of [`${href}.vue`, `${href}/index.vue`]) {
			const file = join(pages, candidate);
			if (existsSync(file)) return readFileSync(file, 'utf8');
		}
		return null;
	}

	// A page redirects with `redirect:` in its meta, a top-level `await
	// navigateTo(…)`, or a `navigateTo(…)` in an inline middleware of its meta.
	// The last alternative stays inside the `definePageMeta({…})` block, so a
	// click handler further down the page never counts.
	const REDIRECTS =
		/\bredirect:|await navigateTo\(|definePageMeta\(\{(?:(?!\n\}\);)[\s\S])*navigateTo\(/;

	it('never offers a page that only redirects somewhere else', () => {
		const redirecting = hrefs(env({ role: 'owner', isDesktop: true })).filter((href) => {
			const source = pageSource(href);
			return source !== null && REDIRECTS.test(source);
		});
		expect(redirecting).toEqual([]);
	});

	it('gives no two rows the same destination', () => {
		const all = hrefs(env({ role: 'owner', isDesktop: true }));
		expect(new Set(all).size).toBe(all.length);
	});
});

/**
 * The palette and the feature middleware read one table, so the palette never
 * offers a page the middleware would bounce to the Workbench. Each case is a
 * flag combination; every destination the palette composes (the sidebar's own
 * items, the route table, settings and admin controls, quick-create pages) must
 * open under it.
 */
describe('palette targets and switched-off features', () => {
	const GATED_FLAGS: readonly FeatureFlagKey[] = [
		...new Set(
			ROUTE_FEATURE_RULES.flatMap((rule) => [
				...(rule.required === undefined
					? []
					: typeof rule.required === 'string'
						? [rule.required]
						: rule.required),
				...(rule.anyOf ?? []),
			])
		),
	];
	const every = (value: boolean): FeatureFlagState =>
		Object.fromEntries(ALL_FEATURE_FLAG_KEYS.map((key) => [key, value])) as FeatureFlagState;

	const COMBINATIONS: ReadonlyArray<readonly [string, FeatureFlagState]> = [
		['every flag on', every(true)],
		['the defaults', getDefaultFlags()],
		['every flag off', every(false)],
		...GATED_FLAGS.map((flag) => [`only ${flag} off`, { ...every(true), [flag]: false }] as const),
		...GATED_FLAGS.map((flag) => [`only ${flag} on`, { ...every(false), [flag]: true }] as const),
	];

	function environments(state: FeatureFlagState, role: 'owner' | 'editor') {
		const resolved = resolveFlags(state);
		const isFeatureEnabled = (flag: FeatureFlagKey) => resolved[flag] === true;
		return {
			isFeatureEnabled,
			nav: env({ isFeatureEnabled, role }),
			admin: { ...ADMIN, isFeatureEnabled },
		};
	}

	/** Every destination `useCommandPaletteProviders` offers for this environment. */
	function paletteHrefs(nav: NavigationEnvironment, admin: AdminEnvironment): string[] {
		const sidebar = buildNavigationSections(nav).flatMap((section) =>
			section.items.map((item) => item.href)
		);
		return [
			...sidebar,
			...routePaletteTargets(nav, new Set(sidebar), admin).map((target) => target.href),
			...settingsControlTargets(nav).map((target) => target.href),
			...adminControlTargets(admin, nav.role !== 'editor').map((target) => target.href),
			...quickCreateEntriesFor(nav).flatMap((entry) => (entry.href ? [entry.href] : [])),
		];
	}

	const CASES = (['owner', 'editor'] as const).flatMap((role) =>
		COMBINATIONS.map(([name, state]) => [role, name, state] as const)
	);

	it.each(CASES)('offers an %s only pages that open with %s', (role, _name, state) => {
		const { isFeatureEnabled, nav, admin } = environments(state, role);
		const bounced = paletteHrefs(nav, admin).filter(
			(href) => blockedFeature(href, isFeatureEnabled) !== null
		);
		expect(bounced).toEqual([]);
	});

	it.each([
		['/dashboard/chat', ['chat']],
		['/dashboard/assistant', ['ai.assistant']],
		['/dashboard/knowledge', ['ai.knowledge']],
		['/dashboard/knowledge/graph', ['ai.knowledge.analytics']],
		['/dashboard/postbox/search', ['postbox', 'mail.external']],
		['/dashboard/postbox/contacts', ['postbox', 'mail.external']],
		['/dashboard/postbox/files', ['postbox', 'mail.external']],
		['/dashboard/postbox/senders', ['postbox', 'mail.external']],
		['/dashboard/postbox/migrate', ['postbox', 'mail.external']],
	] as const)('offers %s only while %j is on', (href, flags) => {
		const off = (flag: FeatureFlagKey) => !(flags as readonly FeatureFlagKey[]).includes(flag);
		expect(hrefs(env({ role: 'owner' }))).toContain(href);
		expect(hrefs(env({ role: 'owner', isFeatureEnabled: off }))).not.toContain(href);
	});
});
