import type { SectionKey } from '~/composables/useSidebarState';

export interface NavigationItem {
	name: string;
	href: string;
	icon: string;
}

export interface NavigationSection {
	key: SectionKey;
	name: string;
	icon: string;
	items: NavigationItem[];
}

/**
 * Single source of truth for the dashboard sidebar destinations, feature-flag
 * filtered. Consumed by both the sidebar (`layouts/dashboard.vue`) and the
 * global command palette (`AppCommandPalette`) so navigation never drifts
 * between the two. Extracted from the layout verbatim — same shape, same order.
 */
export function useDashboardNavigation() {
	const { isEnabled: isFeatureEnabled } = useFeatureFlag();
	const { isDesktop } = useDesktopContext();

	const navigationSections = computed<NavigationSection[]>(() => {
		const settingsItems: NavigationItem[] = [
			{ name: 'Overview', href: '/dashboard/settings', icon: 'lucide:settings' },
			{ name: 'Organization', href: '/dashboard/settings/organization', icon: 'lucide:building-2' },
			{ name: 'Properties', href: '/dashboard/settings/properties', icon: 'lucide:tags' },
			{ name: 'Features', href: '/dashboard/settings/features', icon: 'lucide:toggle-right' },
			...(isFeatureEnabled('ai.agent')
				? [
						{ name: 'AI Agent', href: '/dashboard/settings/agent', icon: 'lucide:bot' },
						{
							name: 'Agent Health',
							href: '/dashboard/settings/agent-health',
							icon: 'lucide:activity',
						},
					]
				: []),
			...(isFeatureEnabled('ai.autonomy')
				? [
						{
							name: 'Autonomy',
							href: '/dashboard/settings/autonomy',
							icon: 'lucide:sliders-horizontal',
						},
					]
				: []),
			{ name: 'Messaging', href: '/dashboard/settings/channels', icon: 'lucide:radio' },
			{ name: 'Account', href: '/dashboard/settings/account', icon: 'lucide:users' },
			...(isDesktop.value
				? [{ name: 'Desktop', href: '/dashboard/settings/desktop', icon: 'lucide:monitor' }]
				: []),
		];

		const inboxItems: NavigationItem[] = [
			{ name: 'All Threads', href: '/dashboard/inbox', icon: 'lucide:message-square' },
			{ name: 'All activity', href: '/dashboard/inbox/activity', icon: 'lucide:activity' },
			{ name: 'Review Queue', href: '/dashboard/inbox/review', icon: 'lucide:check-circle' },
			...(isFeatureEnabled('inbox.codeTasks')
				? [{ name: 'Code Tasks', href: '/dashboard/inbox/code-tasks', icon: 'lucide:code' }]
				: []),
			{ name: 'Quarantine', href: '/dashboard/inbox/quarantine', icon: 'lucide:shield-alert' },
		];

		// Unified "Send" section: everything you send from, in one place. Campaigns,
		// Automations and Transactional are the top-level destinations; the email
		// template surfaces (marketing/transactional templates, saved blocks, media,
		// files) fold under the "Templates & blocks" landing at /dashboard/send.
		const sendItems: NavigationItem[] = [
			...(isFeatureEnabled('campaigns')
				? [{ name: 'Campaigns', href: '/dashboard/campaigns', icon: 'lucide:megaphone' }]
				: []),
			...(isFeatureEnabled('automations')
				? [{ name: 'Automations', href: '/dashboard/automations', icon: 'lucide:zap' }]
				: []),
			...(isFeatureEnabled('transactional')
				? [
						{
							name: 'Transactional',
							href: '/dashboard/send/transactional',
							icon: 'lucide:file-code',
						},
					]
				: []),
			{ name: 'Templates & blocks', href: '/dashboard/send', icon: 'lucide:layout-grid' },
		];

		const sections: NavigationSection[] = [];

		if (isFeatureEnabled('inbox')) {
			sections.push({ key: 'inbox', name: 'Team Inbox', icon: 'lucide:inbox', items: inboxItems });
		}

		if (isFeatureEnabled('postbox') || isFeatureEnabled('mail.external')) {
			sections.push({
				key: 'postbox',
				name: 'Postbox',
				icon: 'lucide:mailbox',
				items: [
					{ name: 'Inbox', href: '/dashboard/postbox/inbox', icon: 'lucide:inbox' },
					{ name: 'Sent', href: '/dashboard/postbox/sent', icon: 'lucide:send' },
					{ name: 'Drafts', href: '/dashboard/postbox/drafts', icon: 'lucide:file-edit' },
					{ name: 'Spam', href: '/dashboard/postbox/spam', icon: 'lucide:shield-alert' },
					{ name: 'Trash', href: '/dashboard/postbox/trash', icon: 'lucide:trash' },
					{ name: 'Settings', href: '/dashboard/postbox/settings', icon: 'lucide:settings' },
				],
			});
		}

		if (isFeatureEnabled('chat')) {
			sections.push({
				key: 'chat',
				name: 'Chat',
				icon: 'lucide:message-circle',
				items: [{ name: 'Messages', href: '/dashboard/chat', icon: 'lucide:message-circle' }],
			});
		}

		if (isFeatureEnabled('ai.assistant')) {
			sections.push({
				key: 'assistant',
				name: 'Assistant',
				icon: 'lucide:sparkles',
				items: [{ name: 'Chat', href: '/dashboard/assistant', icon: 'lucide:sparkles' }],
			});
		}

		sections.push({ key: 'send', name: 'Send', icon: 'lucide:send', items: sendItems });

		// Audience sits directly under Send: who you're writing to, next to the
		// tools that do the writing/sending.
		sections.push({
			key: 'audience',
			name: 'Audience',
			icon: 'lucide:users',
			items: [
				{ name: 'Overview', href: '/dashboard/audience', icon: 'lucide:layout-dashboard' },
				{ name: 'Contacts', href: '/dashboard/audience/contacts', icon: 'lucide:users' },
				{ name: 'Topics', href: '/dashboard/audience/topics', icon: 'lucide:list-filter' },
				{ name: 'Segments', href: '/dashboard/audience/segments', icon: 'lucide:user-plus' },
				{ name: 'Suppressions', href: '/dashboard/audience/suppressions', icon: 'lucide:ban' },
			],
		});

		// Delivery: deliverability promoted to its own first-class section. Health is
		// the landing overview; Setup is the slim config hub (domains, provider
		// routing, webhooks, provider config, API keys). The section header carries a
		// live worst-of status dot (see useDeliveryHealth).
		sections.push({
			key: 'delivery',
			name: 'Delivery',
			icon: 'lucide:truck',
			items: [
				{ name: 'Health', href: '/dashboard/delivery', icon: 'lucide:activity' },
				{ name: 'Setup', href: '/dashboard/delivery/setup', icon: 'lucide:settings-2' },
			],
		});

		if (isFeatureEnabled('ai.knowledge')) {
			sections.push({
				key: 'knowledge',
				name: 'Knowledge',
				icon: 'lucide:brain',
				items: [
					{ name: 'Explorer', href: '/dashboard/knowledge', icon: 'lucide:brain' },
					// Graph dashboard (force-directed view + analytics) — gated on the
					// analytics flag, which also drives the cron that fills the snapshot.
					...(isFeatureEnabled('ai.knowledge.analytics')
						? [{ name: 'Graph', href: '/dashboard/knowledge/graph', icon: 'lucide:share-2' }]
						: []),
				],
			});
		}

		sections.push({
			key: 'settings',
			name: 'Settings',
			icon: 'lucide:settings',
			items: settingsItems,
		});

		return sections;
	});

	return { navigationSections };
}
