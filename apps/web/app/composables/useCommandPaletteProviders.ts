import type { PaletteItem } from '~/lib/commandPalette';
import type { SettingsPaletteItem } from '~/lib/commandPaletteCore';
import { routePaletteTargets } from '~/lib/commandPaletteRoutes';
import { quickCreateEntriesFor, type QuickCreateId } from '~/lib/quickCreate';
import { parseKeywords, settingsControlTargets } from '~/lib/settingsRegistry';

/**
 * Static item providers for the app-wide command palette (AppCommandPalette):
 *   - verbs — New campaign, Compose, New contact, Ask knowledge, updates;
 *   - sidebar-context switch — offers the OTHER context (Inbox ↔ Marketing),
 *     only while the sidebar toggle itself exists (both contexts survived the
 *     feature flags); runs the same last-visited navigation as the toggle;
 *   - navigation — every sidebar destination (shared useDashboardNavigation),
 *     plus every other labelled route in the breadcrumb table (the admin leaves
 *     the sidebar hides behind a hub), deduped by href and gated the same way;
 *   - settings controls — the individual switches from the settings registry,
 *     each deep-linked to the section that holds it, searchable by synonym.
 *
 * The verbs CREATE: "Compose" opens a composer and "New contact" opens the Add
 * dialog, both through the shared `useQuickCreate` entry point — they used to
 * navigate to the matching list and leave the user to find the button.
 *
 * WHICH create verbs exist, and who may run them, is not decided here: the
 * palette projects `lib/quickCreate.ts`, the same registry the header split
 * button and the mobile create sheet read. That table is the reason the palette
 * no longer offers an editor "New contact" — the Add dialog it deep-links to is
 * `canManageContacts` (admin), so the verb was a dead keystroke for everyone
 * else — and the reason a new verb reaches all three surfaces at once. Only the
 * WORDING is the palette's own: a split button under a "Create" label says
 * "Contact", a flat command list has to say "New contact".
 *
 * The query-driven providers (object search, recent searches, surface groups)
 * stay in the component — they are entangled with its input state.
 */

/**
 * Palette row id and copy per registry verb. The ids are stable and shared with
 * the contextual surface providers (`lib/commandPaletteSurfaces.ts` re-emits
 * `verb:new-campaign` only where this provider does not), so they are spelled
 * out rather than derived from the registry id.
 */
const QUICK_CREATE_VERBS: Record<QuickCreateId, { id: string; labelKey: string }> = {
	compose: { id: 'verb:compose', labelKey: 'shared.useCommandPaletteProviders.compose' },
	campaign: { id: 'verb:new-campaign', labelKey: 'shared.useCommandPaletteProviders.newCampaign' },
	contact: { id: 'verb:new-contact', labelKey: 'shared.useCommandPaletteProviders.newContact' },
	automation: {
		id: 'verb:new-automation',
		labelKey: 'shared.useCommandPaletteProviders.newAutomation',
	},
};
export function useCommandPaletteProviders() {
	const { t } = useI18n();
	const { isEnabled: isFeatureEnabled } = useFeatureFlag();
	const { isDesktop } = useDesktopContext();
	const { navigationSections } = useDashboardNavigation();
	const { role } = usePermissions();
	const { openCompose, openNewContact } = useQuickCreate();
	const { showToggle: hasSidebarContexts, activeContext, switchContext } = useSidebarContext();

	const verbItems = computed<PaletteItem[]>(() => {
		const environment = {
			isFeatureEnabled,
			isDesktop: isDesktop.value,
			role: role.value,
		};
		// The create verbs, in registry order and behind the registry's gates. The
		// two that are overlays rather than pages carry no `href`.
		const verbs: PaletteItem[] = quickCreateEntriesFor(environment).map((entry) => {
			const verb = QUICK_CREATE_VERBS[entry.id];
			const href = entry.href;
			return {
				id: verb.id,
				label: t(verb.labelKey),
				icon: entry.icon,
				run: href
					? () => void navigateTo(href)
					: entry.id === 'compose'
						? () => void openCompose()
						: () => void openNewContact(),
			};
		});
		if (isFeatureEnabled('ai.knowledge')) {
			verbs.push({
				id: 'verb:ask-knowledge',
				label: t('shared.useCommandPaletteProviders.askKnowledge'),
				subtitle: t('shared.useCommandPaletteProviders.askKnowledgeSubtitle'),
				icon: 'lucide:sparkles',
				run: () => window.dispatchEvent(new Event('owlat:open-knowledge-query')),
			});
		}
		if (isDesktop.value) {
			verbs.push({
				id: 'verb:check-updates',
				label: t('shared.useCommandPaletteProviders.checkUpdates'),
				icon: 'lucide:download-cloud',
				run: () => window.dispatchEvent(new Event('owlat:check-updates')),
			});
		}
		return verbs;
	});

	const contextItems = computed<PaletteItem[]>(() => {
		if (!hasSidebarContexts.value) return [];
		const other = activeContext.value === 'inbox' ? ('marketing' as const) : ('inbox' as const);
		return [
			{
				id: `context:${other}`,
				label:
					other === 'inbox'
						? t('shared.useCommandPaletteProviders.switchToInbox')
						: t('shared.useCommandPaletteProviders.switchToMarketing'),
				subtitle: t('shared.useCommandPaletteProviders.sidebarContext'),
				icon: other === 'inbox' ? 'lucide:inbox' : 'lucide:megaphone',
				run: () => void switchContext(other),
			},
		];
	});

	// Section/item names come from the navigation registry, so they are message
	// keys resolved here rather than literal copy.
	const sidebarItems = computed<PaletteItem[]>(() =>
		navigationSections.value.flatMap((section) =>
			section.items.map((item) => ({
				id: `nav:${item.href}`,
				label: t(item.name),
				subtitle: t(section.name),
				icon: item.icon,
				run: () => void navigateTo(item.href),
			}))
		)
	);

	// Everything the sidebar does NOT list but the IA still labels: the admin
	// leaves behind their hubs (AI provider, webhooks, ramp controls, …) were
	// unreachable by keyboard entirely. Same gates as the sidebar, so a member is
	// never offered an admin page; deduped by route, so the sidebar's own wording
	// and icon win wherever the two tables overlap.
	const routeItems = computed<PaletteItem[]>(() => {
		const known = new Set(navigationSections.value.flatMap((s) => s.items.map((i) => i.href)));
		const environment = {
			isFeatureEnabled,
			isDesktop: isDesktop.value,
			role: role.value,
		};
		return routePaletteTargets(environment, known).map((target) => ({
			id: `nav:${target.href}`,
			label: t(target.labelKey),
			...(target.contextKey ? { subtitle: t(target.contextKey) } : {}),
			icon: target.icon,
			run: () => void navigateTo(target.href),
		}));
	});

	const navItems = computed<PaletteItem[]>(() => [...sidebarItems.value, ...routeItems.value]);

	// Controls, not destinations: "dark mode" should find Appearance even though
	// no page is called that. The registry declares the synonyms as message keys,
	// so they are resolved — and re-resolved on a locale switch — right here.
	const settingsItems = computed<SettingsPaletteItem[]>(() =>
		settingsControlTargets({ isFeatureEnabled, isDesktop: isDesktop.value }).map((target) => ({
			id: `setting:${target.id}`,
			label: t(target.control.titleKey),
			subtitle: t(target.entry.titleKey),
			icon: target.entry.icon,
			keywords: parseKeywords(t(target.control.keywordsKey)),
			run: () => void navigateTo(target.href),
		}))
	);

	return { verbItems, contextItems, navItems, settingsItems };
}
