import type { Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { type PaletteGroup, type PaletteItem, filterItems } from '~/lib/commandPalette';
import { routePrefixMatcher } from '~/lib/commandPaletteRegistry';
import {
	ArchiveIcon,
	ArrowLeftRightIcon,
	CircleSlashIcon,
	ClockIcon,
	CloudDownloadIcon,
	FolderDownloadIcon,
	ForwardIcon,
	MailIcon,
	PencilIcon,
	PrinterIcon,
	ReplyAllIcon,
	SearchIcon,
	ShieldWarningIcon,
	TagIcon,
	UsersIcon,
} from '@coolicons/vue';

/** Stable registry id (and dedup key) of the Postbox surface provider. */
export const POSTBOX_COMMAND_PROVIDER_ID = 'surface:postbox';

/**
 * Orders Postbox only within the external provider tier — core providers are
 * always consulted first regardless of priority, and the final render position
 * comes from each group's `order`, not this value. It exists so a future second
 * external/plugin provider has a defined position relative to Postbox.
 */
export const POSTBOX_COMMAND_PROVIDER_PRIORITY = 15;

/**
 * Route gate for the Postbox provider: the Postbox surface exactly or any nested
 * child, but not a sibling like `/dashboard/postbox-archive`.
 */
export const matchPostboxRoute = routePrefixMatcher('/dashboard/postbox');

/**
 * Registers Postbox as a command-palette provider while its layout is mounted.
 *
 * The palette (Cmd/Ctrl-K, layouts/dashboard.vue) is the shared shell; Postbox is
 * a consumer — it contributes its reader actions + the folders/searches the
 * sidebar doesn't list. Reader actions dispatch `owlat:postbox-reader-action`
 * (a no-op when no conversation is open); the sidebar nav already covers
 * Inbox/Sent/Drafts/Spam/Trash/Settings, so this only adds the rest.
 *
 * The provider is route-gated to `/dashboard/postbox` so its groups never leak
 * onto another surface even if the registration outlives a route change, and it
 * filters its own items by the palette query (the shell no longer does that on
 * a shared bucket). `build` reads the reactive mailbox sections at call time, so
 * team-inbox entries still appear the instant a shared inbox's membership
 * resolves — no explicit watch needed.
 *
 * Forward, Move and "Label as…" share their ids with the open conversation's
 * provider (`usePostboxThreadCommandSurface`), which is consulted first: while a
 * conversation is open its direct verbs win and these broadcast twins drop out.
 *
 * Extracted from PostboxLayout.vue to keep the layout under the file-size cap;
 * mirrors how the sidebar nav was pulled into `useDashboardNavigation`.
 */
export function usePostboxCommandSurface(mailboxId: Ref<Id<'mailboxes'>>) {
	const { t } = useI18n();
	const composeNav = usePostboxComposeNav();
	const { isDesktop: isDesktopSurface } = useDesktopContext();
	// Accessible mailboxes → palette "switch mailbox" entries (personal when
	// there's a choice, plus every team inbox). Reactive so entries appear the
	// instant a shared inbox's membership resolves.
	const { sections, switchToMailbox } = usePostboxMailbox();
	// The mailbox's labels, for the `#` mode and for the "Label as…" argument
	// step. Read at build time so a label created mid-session shows up.
	const { labels } = usePostboxLabels(mailboxId);

	function dispatchReaderAction(action: string, detail: Record<string, unknown> = {}) {
		window.dispatchEvent(
			new CustomEvent('owlat:postbox-reader-action', { detail: { action, ...detail } })
		);
	}

	function buildSurfaceGroups(query: string): PaletteGroup[] {
		const groups: PaletteGroup[] = [
			{
				key: 'postbox-actions',
				heading: t('shared.postbox.usePostboxCommandSurface.groups.mailbox'),
				order: 0,
				cap: 12,
				mode: 'commands',
				items: [
					{
						id: 'postbox:compose',
						label: t('shared.postbox.usePostboxCommandSurface.items.compose'),
						shortcutId: 'global.compose',
						icon: PencilIcon,
						run: () => void composeNav.open({ mailboxId: mailboxId.value }),
					},
					{
						id: 'postbox:reply-all',
						label: t('shared.postbox.usePostboxCommandSurface.items.replyAll'),
						shortcutId: 'postbox.replyAll',
						icon: ReplyAllIcon,
						run: () => dispatchReaderAction('replyAll'),
					},
					{
						id: 'postbox:forward',
						label: t('shared.postbox.usePostboxCommandSurface.items.forward'),
						shortcutId: 'postbox.forward',
						icon: ForwardIcon,
						run: () => dispatchReaderAction('forward'),
					},
					{
						id: 'postbox:report-spam',
						label: t('shared.postbox.usePostboxCommandSurface.items.reportSpam'),
						icon: ShieldWarningIcon,
						run: () => dispatchReaderAction('reportSpam'),
					},
					{
						id: 'postbox:block-sender',
						label: t('shared.postbox.usePostboxCommandSurface.items.blockSender'),
						icon: CircleSlashIcon,
						run: () => dispatchReaderAction('blockSender'),
					},
					{
						id: 'postbox:move',
						label: t('shared.postbox.usePostboxCommandSurface.items.move'),
						shortcutId: 'postbox.move',
						icon: FolderDownloadIcon,
						run: () => dispatchReaderAction('move'),
					},
					{
						id: 'postbox:print',
						label: t('shared.postbox.usePostboxCommandSurface.items.print'),
						icon: PrinterIcon,
						run: () => dispatchReaderAction('print'),
					},
					{
						// Two-step: one row that asks WHICH label, instead of one row per
						// label drowning every other command in the palette.
						id: 'postbox:label-as',
						label: t('shared.postbox.usePostboxCommandSurface.items.labelAs'),
						icon: TagIcon,
						run: () => {},
						argument: {
							promptKey: 'shared.postbox.usePostboxCommandSurface.argument.labelPrompt',
							headingKey: 'shared.postbox.usePostboxCommandSurface.groups.labels',
							icon: TagIcon,
							options: labels.value.map((label) => ({
								id: `label-${label._id}`,
								label: label.name,
								run: () => dispatchReaderAction('label', { labelId: label._id }),
							})),
						},
					},
				],
			},
			{
				key: 'postbox-folders',
				heading: t('shared.dashboardNavigation.sections.postbox'),
				order: 12,
				mode: 'labels',
				items: [
					{
						id: 'postbox:archive',
						label: t('shared.postbox.usePostboxCommandSurface.items.archive'),
						icon: ArchiveIcon,
						run: () => void navigateTo('/dashboard/postbox/archive'),
					},
					{
						id: 'postbox:snoozed',
						label: t('shared.postbox.usePostboxCommandSurface.items.snoozed'),
						icon: ClockIcon,
						run: () => void navigateTo('/dashboard/postbox/snoozed'),
					},
					{
						id: 'postbox:search',
						label: t('shared.postbox.usePostboxCommandSurface.items.search'),
						shortcutId: 'postbox.search',
						icon: SearchIcon,
						run: () => void navigateTo('/dashboard/postbox/search'),
					},
					{
						id: 'postbox:contacts',
						label: t('shared.postbox.usePostboxCommandSurface.items.contacts'),
						icon: UsersIcon,
						run: () => void navigateTo('/dashboard/postbox/contacts'),
					},
				],
			},
		];

		// "Switch mailbox ›" — personal mailboxes (only when there's a real choice)
		// plus every shared team inbox, as ONE row with a submenu. Both blocks
		// share one descriptor list (icon + message key are the only differences).
		// Empty for a lone personal mailbox, so the palette is unchanged for
		// single-mailbox users.
		const { personal, team } = sections.value;
		const switchGroups = [
			{
				items: personal.length > 1 || team.length > 0 ? personal : [],
				icon: MailIcon,
				labelKey: 'shared.postbox.usePostboxCommandSurface.items.switchToMailbox',
			},
			{
				items: team,
				icon: UsersIcon,
				labelKey: 'shared.postbox.usePostboxCommandSurface.items.switchToTeamInbox',
			},
		];
		const switchItems = switchGroups.flatMap((group) =>
			group.items.map((mb) => ({
				id: `postbox:switch-${mb.mailboxId}`,
				label: t(group.labelKey, { mailbox: mb.label }),
				icon: group.icon,
				run: () => switchToMailbox(mb.mailboxId),
			}))
		);
		if (switchItems.length > 0) {
			const submenu: PaletteItem = {
				id: 'postbox:switch-mailbox',
				label: t('shared.postbox.usePostboxCommandSurface.items.switchMailbox'),
				icon: ArrowLeftRightIcon,
				run: () => {},
				argument: {
					promptKey: 'shared.postbox.usePostboxCommandSurface.argument.switchPrompt',
					headingKey: 'shared.postbox.usePostboxCommandSurface.groups.switchMailbox',
					icon: MailIcon,
					options: switchGroups.flatMap((group) =>
						group.items.map((mb) => ({
							id: `switch-${mb.mailboxId}`,
							label: mb.label,
							icon: group.icon,
							run: () => switchToMailbox(mb.mailboxId),
						}))
					),
				},
			};
			groups.push({
				key: 'postbox-switch-mailbox',
				heading: t('shared.postbox.usePostboxCommandSurface.groups.switchMailbox'),
				order: 24,
				mode: 'commands',
				// Typed, a mailbox's own row is one Enter away ("Switch to Support").
				items: query.trim() ? [submenu, ...switchItems] : [submenu],
			});
		}

		// Labels as destinations — the `#` mode's other half (folders above), and
		// the only place the palette lists them at all.
		if (labels.value.length > 0) {
			groups.push({
				key: 'postbox-labels',
				heading: t('shared.postbox.usePostboxCommandSurface.groups.labels'),
				order: 13,
				cap: 8,
				mode: 'labels',
				items: labels.value.map((label) => ({
					id: `postbox:label-${label._id}`,
					label: label.name,
					icon: TagIcon,
					run: () => void navigateTo(`/dashboard/postbox/label/${label._id}`),
				})),
			});
		}

		if (isDesktopSurface.value) {
			groups[0]?.items.push({
				id: 'postbox:check-updates',
				label: t('shared.postbox.usePostboxCommandSurface.items.checkUpdates'),
				icon: CloudDownloadIcon,
				run: () => window.dispatchEvent(new Event('owlat:check-updates')),
			});
		}
		return groups;
	}

	registerCommandPaletteProvider({
		id: POSTBOX_COMMAND_PROVIDER_ID,
		priority: POSTBOX_COMMAND_PROVIDER_PRIORITY,
		matchRoute: matchPostboxRoute,
		build: ({ query }) =>
			buildSurfaceGroups(query).map((group) => ({
				...group,
				items: filterItems(group.items, query),
			})),
	});
}
