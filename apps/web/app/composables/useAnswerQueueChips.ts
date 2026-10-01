/**
 * The Answer queue's filter chips: everything, each inbox with something
 * waiting, the team inbox, chat. The queue page shows them as a row; Answer
 * mode's queue bar lists them in its menu. Selecting one narrows the queue
 * (`?in=`), which restarts it on its first item.
 */
import type { AnswerItem } from '~/composables/useAnswerQueue';
import type { AnswerQueueSession } from '~/composables/useAnswerQueueSession';

export interface AnswerQueueChip {
	id: string;
	label: string;
	count: number;
	slot?: number | null;
	icon?: string;
}

export function useAnswerQueueChips(session: Pick<AnswerQueueSession, 'queue' | 'filter'> | null) {
	const { t } = useI18n();
	const { inboxes } = useInboxes();
	const items = computed<readonly AnswerItem[]>(() => session?.queue.items.value ?? []);
	const filter = computed(() => session?.filter.value ?? 'all');

	const chips = computed(() => {
		const count = (pred: (i: AnswerItem) => boolean) => items.value.filter(pred).length;
		const list: AnswerQueueChip[] = [
			{ id: 'all', label: t('components.answer.filter.all'), count: items.value.length },
		];
		for (const inbox of inboxes.value) {
			const n = count((i) => i.source === 'mail' && i.mailboxId === inbox.mailboxId);
			if (n > 0) list.push({ id: inbox.mailboxId, label: inbox.name, count: n, slot: inbox.slot });
		}
		const team = count((i) => i.source === 'team');
		if (team > 0)
			list.push({
				id: 'team',
				label: t('components.shell.teamInbox'),
				count: team,
				icon: 'lucide:bot',
			});
		const chat = count((i) => i.source === 'mention');
		if (chat > 0)
			list.push({
				id: 'chat',
				label: t('components.shell.chat.title'),
				count: chat,
				icon: 'lucide:message-circle',
			});
		// A link can land on a filter with nothing in it (`?in=team` once the team
		// queue is clear). Keep that chip visible so the page says what it is
		// filtered to, instead of looking like the whole queue is empty.
		const active = filter.value;
		if (active !== 'all' && !list.some((chip) => chip.id === active)) {
			const inbox = inboxes.value.find((i) => i.mailboxId === active);
			if (active === 'team') {
				list.push({
					id: 'team',
					label: t('components.shell.teamInbox'),
					count: 0,
					icon: 'lucide:bot',
				});
			} else if (active === 'chat') {
				list.push({
					id: 'chat',
					label: t('components.shell.chat.title'),
					count: 0,
					icon: 'lucide:message-circle',
				});
			} else if (inbox) {
				list.push({ id: inbox.mailboxId, label: inbox.name, count: 0, slot: inbox.slot });
			}
		}
		return list;
	});

	// The chip row earns its space once there is a choice to make — or when the
	// page is already filtered, so the filter is visible and can be cleared.
	const showChips = computed(() => chips.value.length > 2 || filter.value !== 'all');
	const activeChipLabel = computed(
		() => chips.value.find((chip) => chip.id === filter.value && chip.id !== 'all')?.label ?? null
	);

	return { chips, showChips, activeChipLabel };
}
