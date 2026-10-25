import { inject } from 'vue';
import type { ContextMenuItem } from '@owlat/ui/components/ui/ContextMenu.vue';
import type { TodaySource } from '~/utils/todayDigest';
import { TODAY_PEEK, threadHref } from '~/utils/todayPeek';
import { useRowLinkMenu } from '~/composables/useRowLinkMenu';
import { useShortcutLabels } from '~/composables/useShortcutLabels';

/**
 * The context menu of a Workbench line ("What changed", "Updates"): the verbs
 * the line's keys already run (open, reply anyway, done), labelled with those
 * keys, then the conversation's link verbs.
 *
 * "Open" peeks at the line's sources, like Enter on the line; the line's own
 * buttons and the page's handlers own done and reply, so every entry point
 * runs the same handler.
 */
export function useTodayLineMenu() {
	const { t } = useI18n();
	const { labelFor } = useShortcutLabels();
	const { linkItems } = useRowLinkMenu();
	const peek = inject(TODAY_PEEK, null);

	const key = (id: string) => labelFor(id) ?? undefined;

	return function menuFor(
		line: { sources: readonly TodaySource[] },
		verbs: { done: () => void; replyAnyway?: (() => void) | null }
	): ContextMenuItem[] {
		const sources = [...line.sources];
		const first = sources[0];
		const items: ContextMenuItem[] = [];
		if (first && peek) {
			items.push(
				{
					id: 'open',
					label: t('components.today.line.open'),
					icon: 'lucide:eye',
					shortcut: key('workbench.open'),
					run: () => peek.open(sources),
				},
				{
					id: 'open-thread',
					label: t('components.today.line.openThread'),
					icon: 'lucide:arrow-right',
					run: () => peek.openThread(first),
				}
			);
		}
		if (verbs.replyAnyway) {
			const reply = verbs.replyAnyway;
			items.push({
				id: 'reply-anyway',
				label: t('components.today.line.replyAnyway'),
				icon: 'lucide:reply',
				shortcut: key('workbench.reply'),
				separatorBefore: items.length > 0,
				run: reply,
			});
		}
		items.push({
			id: 'done',
			label: t('components.today.line.done'),
			icon: 'lucide:check',
			shortcut: key('workbench.done'),
			separatorBefore: items.length > 0 && !verbs.replyAnyway,
			run: verbs.done,
		});
		if (first) items.push(...linkItems(threadHref(first)));
		return items;
	};
}
