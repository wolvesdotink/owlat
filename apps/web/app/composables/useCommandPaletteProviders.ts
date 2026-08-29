import type { PaletteItem } from '~/lib/commandPalette';
import type { SettingsPaletteItem } from '~/lib/commandPaletteCore';
import { parseKeywords, settingsControlTargets } from '~/lib/settingsRegistry';

/**
 * Static item providers for the app-wide command palette (AppCommandPalette):
 *   - verbs — New campaign, Compose, New contact, Ask knowledge, updates;
 *   - sidebar-context switch — offers the OTHER context (Inbox ↔ Marketing),
 *     only while the sidebar toggle itself exists (both contexts survived the
 *     feature flags); runs the same last-visited navigation as the toggle;
 *   - navigation — every sidebar destination (shared useDashboardNavigation);
 *   - settings controls — the individual switches from the settings registry,
 *     each deep-linked to the section that holds it, searchable by synonym.
 *
 * The query-driven providers (object search, recent searches, surface groups)
 * stay in the component — they are entangled with its input state.
 */
export function useCommandPaletteProviders() {
	const { t } = useI18n();
	const { isEnabled: isFeatureEnabled } = useFeatureFlag();
	const { isDesktop } = useDesktopContext();
	const { navigationSections } = useDashboardNavigation();
	const { showToggle: hasSidebarContexts, activeContext, switchContext } = useSidebarContext();

	const verbItems = computed<PaletteItem[]>(() => {
		const verbs: PaletteItem[] = [];
		if (isFeatureEnabled('campaigns')) {
			verbs.push({
				id: 'verb:new-campaign',
				label: t('shared.useCommandPaletteProviders.newCampaign'),
				icon: 'lucide:megaphone',
				run: () => void navigateTo('/dashboard/campaigns/new'),
			});
		}
		if (isFeatureEnabled('postbox') || isFeatureEnabled('mail.external')) {
			verbs.push({
				id: 'verb:compose',
				label: t('shared.useCommandPaletteProviders.compose'),
				icon: 'lucide:pencil',
				run: () => void navigateTo('/dashboard/postbox/inbox'),
			});
		}
		verbs.push({
			id: 'verb:new-contact',
			label: t('shared.useCommandPaletteProviders.newContact'),
			icon: 'lucide:user-plus',
			run: () => void navigateTo('/dashboard/audience/contacts'),
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
	const navItems = computed<PaletteItem[]>(() =>
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
