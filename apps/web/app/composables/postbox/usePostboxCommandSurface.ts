import type { Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { type PaletteGroup, useCommandPaletteSurface } from '~/lib/commandPalette';

/**
 * Registers Postbox as the app command palette's "current surface" while mounted.
 *
 * The palette (Cmd/Ctrl-K, layouts/dashboard.vue) is the shared shell; Postbox is
 * a consumer — it contributes its reader actions + the folders/searches the
 * sidebar doesn't list. Reader actions dispatch `owlat:postbox-reader-action`
 * (a no-op when no conversation is open); the sidebar nav already covers
 * Inbox/Sent/Drafts/Spam/Trash/Settings, so this only adds the rest.
 *
 * Extracted from PostboxLayout.vue to keep the layout under the file-size cap;
 * mirrors how the sidebar nav was pulled into `useDashboardNavigation`.
 */
export function usePostboxCommandSurface(mailboxId: Ref<Id<'mailboxes'>>) {
	const composerStack = usePostboxComposerStack();
	const { isDesktop: isDesktopSurface } = useDesktopContext();
	const paletteSurface = useCommandPaletteSurface();
	// Accessible mailboxes → palette "switch mailbox" entries (personal when
	// there's a choice, plus every team inbox). Reactive so entries appear the
	// instant a shared inbox's membership resolves.
	const { sections, switchToMailbox } = usePostboxMailbox();

	function dispatchReaderAction(action: string) {
		window.dispatchEvent(new CustomEvent('owlat:postbox-reader-action', { detail: { action } }));
	}

	function buildSurfaceGroups(): PaletteGroup[] {
		const groups: PaletteGroup[] = [
			{
				key: 'postbox-actions',
				heading: 'Mailbox',
				order: 0,
				cap: 12,
				items: [
					{
						id: 'postbox:compose',
						label: 'Compose new message',
						hint: 'c',
						icon: 'lucide:pencil',
						run: () => composerStack.open({ mailboxId: mailboxId.value }),
					},
					{
						id: 'postbox:reply-all',
						label: 'Reply all',
						hint: 'a',
						icon: 'lucide:reply-all',
						run: () => dispatchReaderAction('replyAll'),
					},
					{
						id: 'postbox:forward',
						label: 'Forward',
						hint: 'f',
						icon: 'lucide:forward',
						run: () => dispatchReaderAction('forward'),
					},
					{
						id: 'postbox:report-spam',
						label: 'Report spam',
						icon: 'lucide:shield-alert',
						run: () => dispatchReaderAction('reportSpam'),
					},
					{
						id: 'postbox:block-sender',
						label: 'Block sender',
						icon: 'lucide:ban',
						run: () => dispatchReaderAction('blockSender'),
					},
					{
						id: 'postbox:move',
						label: 'Move conversation…',
						hint: 'v',
						icon: 'lucide:folder-input',
						run: () => dispatchReaderAction('move'),
					},
					{
						id: 'postbox:print',
						label: 'Print conversation',
						icon: 'lucide:printer',
						run: () => dispatchReaderAction('print'),
					},
				],
			},
			{
				key: 'postbox-folders',
				heading: 'Postbox',
				order: 12,
				items: [
					{
						id: 'postbox:archive',
						label: 'Archive',
						icon: 'lucide:archive',
						run: () => void navigateTo('/dashboard/postbox/archive'),
					},
					{
						id: 'postbox:snoozed',
						label: 'Snoozed',
						icon: 'lucide:clock',
						run: () => void navigateTo('/dashboard/postbox/snoozed'),
					},
					{
						id: 'postbox:search',
						label: 'Search mail',
						hint: '/',
						icon: 'lucide:search',
						run: () => void navigateTo('/dashboard/postbox/search'),
					},
					{
						id: 'postbox:contacts',
						label: 'Contacts',
						icon: 'lucide:users',
						run: () => void navigateTo('/dashboard/postbox/contacts'),
					},
				],
			},
		];

		// "Switch mailbox" — personal mailboxes (only when there's a real choice)
		// plus every shared team inbox. Both blocks share one descriptor list (icon
		// + label suffix are the only differences). Empty for a lone personal
		// mailbox, so the palette is unchanged for single-mailbox users.
		const { personal, team } = sections.value;
		const switchGroups = [
			{
				items: personal.length > 1 || team.length > 0 ? personal : [],
				icon: 'lucide:mail',
				suffix: '',
			},
			{ items: team, icon: 'lucide:users', suffix: ' (team inbox)' },
		];
		const switchItems = switchGroups.flatMap((group) =>
			group.items.map((mb) => ({
				id: `postbox:switch-${mb.mailboxId}`,
				label: `Go to ${mb.label}${group.suffix}`,
				icon: group.icon,
				run: () => switchToMailbox(mb.mailboxId),
			}))
		);
		if (switchItems.length > 0) {
			groups.push({
				key: 'postbox-switch-mailbox',
				heading: 'Switch mailbox',
				order: 24,
				items: switchItems,
			});
		}

		if (isDesktopSurface.value) {
			groups[0]?.items.push({
				id: 'postbox:check-updates',
				label: 'Check for updates',
				icon: 'lucide:download-cloud',
				run: () => window.dispatchEvent(new Event('owlat:check-updates')),
			});
		}
		return groups;
	}

	// Rebuild reactively so team-inbox entries appear as membership resolves.
	watch(sections, () => (paletteSurface.value = buildSurfaceGroups()), { immediate: true });
	onBeforeUnmount(() => {
		paletteSurface.value = [];
	});
}
