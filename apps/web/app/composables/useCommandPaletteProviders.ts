import type { PaletteItem } from '~/lib/commandPalette';

/**
 * Static item providers for the app-wide command palette (AppCommandPalette):
 *   - verbs — New campaign, Compose, New contact, Ask knowledge, updates;
 *   - sidebar-context switch — offers the OTHER context (Inbox ↔ Marketing),
 *     only while the sidebar toggle itself exists (both contexts survived the
 *     feature flags); runs the same last-visited navigation as the toggle;
 *   - navigation — every sidebar destination (shared useDashboardNavigation).
 *
 * The query-driven providers (object search, recent searches, surface groups)
 * stay in the component — they are entangled with its input state.
 */
export function useCommandPaletteProviders() {
	const { isEnabled: isFeatureEnabled } = useFeatureFlag();
	const { isDesktop } = useDesktopContext();
	const { navigationSections } = useDashboardNavigation();
	const { showToggle: hasSidebarContexts, activeContext, switchContext } = useSidebarContext();

	const verbItems = computed<PaletteItem[]>(() => {
		const verbs: PaletteItem[] = [];
		if (isFeatureEnabled('campaigns')) {
			verbs.push({
				id: 'verb:new-campaign',
				label: 'New campaign',
				icon: 'lucide:megaphone',
				run: () => void navigateTo('/dashboard/campaigns/new'),
			});
		}
		if (isFeatureEnabled('postbox') || isFeatureEnabled('mail.external')) {
			verbs.push({
				id: 'verb:compose',
				label: 'Compose message',
				icon: 'lucide:pencil',
				run: () => void navigateTo('/dashboard/postbox/inbox'),
			});
		}
		verbs.push({
			id: 'verb:new-contact',
			label: 'New contact',
			icon: 'lucide:user-plus',
			run: () => void navigateTo('/dashboard/audience/contacts'),
		});
		if (isFeatureEnabled('ai.knowledge')) {
			verbs.push({
				id: 'verb:ask-knowledge',
				label: 'Ask knowledge…',
				subtitle: 'Search your knowledge base',
				icon: 'lucide:sparkles',
				run: () => window.dispatchEvent(new Event('owlat:open-knowledge-query')),
			});
		}
		if (isDesktop.value) {
			verbs.push({
				id: 'verb:check-updates',
				label: 'Check for updates',
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
				label: other === 'inbox' ? 'Switch to Inbox' : 'Switch to Marketing',
				subtitle: 'Sidebar context',
				icon: other === 'inbox' ? 'lucide:inbox' : 'lucide:megaphone',
				run: () => void switchContext(other),
			},
		];
	});

	const navItems = computed<PaletteItem[]>(() =>
		navigationSections.value.flatMap((section) =>
			section.items.map((item) => ({
				id: `nav:${item.href}`,
				label: item.name,
				subtitle: section.name,
				icon: item.icon,
				run: () => void navigateTo(item.href),
			}))
		)
	);

	return { verbItems, contextItems, navItems };
}
