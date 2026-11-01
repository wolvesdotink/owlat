import type { Ref } from 'vue';
import type { ContextMenuItem } from '@owlat/ui/components/ui/ContextMenu.vue';
import type { InboxListThread } from '~/composables/useInboxListActions';
import { useRowLinkMenu } from '~/composables/useRowLinkMenu';
import { useShortcutLabels } from '~/composables/useShortcutLabels';
import {
	CircleCheckIcon,
	ClockIcon,
	SquareCheckIcon,
	SquareMinusIcon,
	UserCheckCornerIcon,
	UserPlusCornerIcon,
} from '@coolicons/vue';

/** The verbs a Team Inbox row's swipe can fire. */
export type InboxRowSwipeAction = 'resolve' | 'snooze' | 'none';

/**
 * The Team Inbox row's context menu (right-click, the menu key, a long-press):
 * the row's verbs with the key that runs each from the list.
 *
 * A verb acts on what `targetsFor` returns, which is the whole selection when
 * the row is part of it and the row alone otherwise, and its label counts the
 * rows whenever that is more than one ("Resolve (3)"), so the menu says exactly
 * what it is about to touch. Opening the row, selecting it and the link verbs
 * are always about the row itself.
 */
export function useInboxRowMenu(opts: {
	/** Admins triage; everyone else gets open and the link verbs. */
	canManage: Ref<boolean>;
	targetsFor: (thread: InboxListThread) => InboxListThread[];
	isSelected: (id: string) => boolean;
	toggleSelect: (thread: InboxListThread) => void;
	assignToMe: (targets: InboxListThread[]) => void;
	/** Open the assignee picker for these targets (the row's, or the bulk bar's). */
	openAssign: (thread: InboxListThread, targets: InboxListThread[]) => void;
	resolve: (targets: InboxListThread[]) => void;
	snooze: (targets: InboxListThread[]) => void;
}) {
	const { t } = useI18n();
	const { labelFor, ariaFor } = useShortcutLabels();
	const { linkItems, openItem } = useRowLinkMenu();

	function keyed(id: string): Pick<ContextMenuItem, 'shortcut' | 'ariaKeyshortcuts'> {
		const shortcut = labelFor(id);
		const aria = ariaFor(id);
		return { ...(shortcut ? { shortcut } : {}), ...(aria ? { ariaKeyshortcuts: aria } : {}) };
	}

	/** "Resolve", or "Resolve (3)" when the verb reaches more than this row. */
	function counted(key: string, count: number): string {
		return count > 1 ? t('components.inbox.rowMenu.counted', { verb: t(key), count }) : t(key);
	}

	return function menuFor(thread: InboxListThread): ContextMenuItem[] {
		const href = `/dashboard/inbox/${thread._id}`;
		const open = { ...openItem(href), ...keyed('inboxList.open') };
		if (!opts.canManage.value) return [open, ...linkItems(href)];
		const targets = opts.targetsFor(thread);
		const n = targets.length;
		const selected = opts.isSelected(thread._id);
		return [
			open,
			{
				id: 'select',
				label: selected
					? t('components.inbox.inboxThreadRow.deselect')
					: t('components.inbox.inboxThreadRow.select'),
				icon: selected ? SquareMinusIcon : SquareCheckIcon,
				...keyed('inboxList.toggleSelect'),
				run: () => opts.toggleSelect(thread),
			},
			{
				id: 'assign-to-me',
				label: counted('components.inbox.rowMenu.assignToMe', n),
				icon: UserCheckCornerIcon,
				separatorBefore: true,
				...keyed('inboxList.assignToMe'),
				run: () => opts.assignToMe(targets),
			},
			{
				id: 'assign',
				label: counted('components.inbox.rowMenu.assign', n),
				icon: UserPlusCornerIcon,
				...keyed('inboxList.assign'),
				run: () => opts.openAssign(thread, targets),
			},
			{
				id: 'resolve',
				label: counted('components.inbox.inboxThreadRow.resolve', n),
				icon: CircleCheckIcon,
				...keyed('inboxList.resolve'),
				run: () => opts.resolve(targets),
			},
			{
				id: 'snooze',
				label: counted('components.inbox.rowMenu.snooze', n),
				icon: ClockIcon,
				...keyed('inboxList.snooze'),
				run: () => opts.snooze(targets),
			},
			...linkItems(href),
		];
	};
}
