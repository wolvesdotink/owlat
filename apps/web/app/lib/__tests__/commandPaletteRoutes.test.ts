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
import type { NavigationEnvironment } from '../dashboardNavigationCore';
import { routePaletteTargets } from '../commandPaletteRoutes';
import { createTestI18n } from '~/__tests__/i18n';

const { t } = createTestI18n().global;

function env(overrides: Partial<NavigationEnvironment> = {}): NavigationEnvironment {
	return {
		isFeatureEnabled: () => true,
		isDesktop: false,
		role: 'admin',
		...overrides,
	};
}

function hrefs(environment = env(), known: Iterable<string> = []): string[] {
	return routePaletteTargets(environment, new Set(known)).map((target) => target.href);
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
		const target = routePaletteTargets(env(), new Set()).find(
			(entry) => entry.href === '/dashboard/admin/instance/ai-provider'
		);
		expect(target).toMatchObject({
			labelKey: 'shared.breadcrumbRoutes.pages.aiProvider',
			contextKey: 'shared.breadcrumbRoutes.subsections.instance',
			icon: 'lucide:shield-check',
		});
	});

	it('gives a section root no context line', () => {
		const target = routePaletteTargets(env(), new Set()).find(
			(entry) => entry.href === '/dashboard/automations'
		);
		expect(target?.labelKey).toBe('shared.breadcrumbRoutes.sections.automations');
		expect(target?.contextKey).toBeUndefined();
	});

	it('renders every derived key as words, never as a key path', () => {
		for (const target of routePaletteTargets(env(), new Set())) {
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

	it('takes a section with its feature flag', () => {
		const reachable = hrefs(env({ isFeatureEnabled: (flag) => flag !== 'campaigns' }));
		expect(reachable.filter((href) => href.startsWith('/dashboard/campaigns'))).toEqual([]);
		expect(reachable).toContain('/dashboard/admin/instance/ai-provider');
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
