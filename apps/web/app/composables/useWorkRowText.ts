import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { Ref } from 'vue';
import type { AnswerItem } from '~/composables/useAnswerQueue';
import { briefLocale } from '~/composables/threadBrief/briefApi';
import { useLocalized } from '~/composables/useLocalized';
import { replyQueueHeadline } from '~/utils/postboxReplyQueue';
import { parseFromHeader } from '~/utils/todayDigest';
import { briefMoreChip, briefRowLatest } from '~/utils/briefRowLine';
import { briefDueDate } from '~/utils/threadBriefContext';
import { idBatches, type WorkTodoRow } from '~/utils/workbenchWork';

/**
 * How a piece of work reads on the Workbench: the sentence it leads with, the
 * line under it, the "+N more" chip and the due date, for a reply waiting in
 * the Answer queue and for a request that needs no reply.
 *
 * The privacy rules live here, once:
 *   - a team row leads with its top open action, never a summary;
 *   - a shared mailbox's row shows the item beside the raw preview, never the
 *     AI's ask summary or latest-update line;
 *   - with the viewer's brief turned off ("Show the brief above
 *     conversations"), a personal row reads like plain mail: subject, sender
 *     and preview, without AI wording or the "+N more" chip.
 */
/** The most threads `inbox.teamStream.topItems` takes in one read. */
export const TEAM_TOP_BATCH = 10;

export function useWorkRowText(answerItems: Ref<readonly AnswerItem[]>) {
	const { t, locale } = useI18n();
	const text = useLocalized();
	const { autoSummarize } = usePostboxSettings();
	const { byId } = useInboxes();

	// A team row leads with its top open action (inbox.teamStream.topItems).
	// That read takes at most TEAM_TOP_BATCH threads, so a long queue asks in
	// batches; one batch failing leaves the others' rows their actions.
	const teamThreadBatches = computed(() =>
		idBatches(
			answerItems.value.flatMap((item) =>
				item.source === 'team' && item.entry.thread?._id ? [item.entry.thread._id] : []
			),
			TEAM_TOP_BATCH
		)
	);
	const teamTops = useConvexQueryMap(api.inbox.teamStream.topItems, teamThreadBatches, (batch) => ({
		threadIds: batch.split(',') as Id<'conversationThreads'>[],
		locale: briefLocale(locale.value),
	}));
	function teamTopOf(item: AnswerItem) {
		if (item.source !== 'team') return null;
		const threadId = item.entry.thread?._id;
		for (const result of teamTops.values()) {
			const row = (result.data.value ?? []).find((r) => r.threadId === threadId);
			if (row) return row;
		}
		return null;
	}

	function isSharedRow(item: AnswerItem): boolean {
		return (
			item.source === 'mail' &&
			(item.inbox?.scope === 'shared' || item.row.briefTop?.mode === 'actions')
		);
	}

	function answerTitle(item: AnswerItem): string {
		if (item.source === 'mail') {
			return text(
				replyQueueHeadline(item.row, locale.value, {
					isShared: isSharedRow(item),
					showBrief: autoSummarize.value || isSharedRow(item),
				})
			);
		}
		if (item.source === 'team') {
			return teamTopOf(item)?.text || item.entry.message.subject || t('components.shell.noSubject');
		}
		return t('components.today.answer.mentionTitle', {
			room: item.mention.roomName,
			preview: item.mention.messagePreview,
		});
	}

	/**
	 * Under the title: a personal row names the sender, the subject and the
	 * brief's latest update; a shared mailbox's row and a team row name the
	 * sender and the raw preview, never a summary.
	 */
	function answerDetail(item: AnswerItem): string {
		const quoted = (raw: string | undefined) => (raw?.trim() ? `“${raw.trim()}”` : '');
		if (item.source === 'mail') {
			// A follow-up headline already names who ("You're waiting on …").
			const who = item.row.fromName || item.row.fromAddress;
			const named = answerTitle(item).includes(who) ? '' : who;
			const top = item.row.briefTop;
			const parts =
				isSharedRow(item) || !autoSummarize.value
					? [named, quoted(item.row.snippet)]
					: top?.top
						? [named, item.row.subject, briefRowLatest(top, locale.value) ?? '']
						: [named];
			return parts.filter(Boolean).join(' · ');
		}
		if (item.source === 'team') {
			const from = parseFromHeader(item.entry.message.from);
			return [from.name ?? from.address, quoted(item.entry.thread?.lastPreview)]
				.filter(Boolean)
				.join(' · ');
		}
		return '';
	}

	/** "+3 more": the thread's other open items (exact counts). */
	function answerMore(item: AnswerItem): string {
		const team = teamTopOf(item);
		if (team) {
			const chip = briefMoreChip(team.count);
			return chip ? t(chip.key, { count: chip.count }) : '';
		}
		if (item.source !== 'mail' || (!autoSummarize.value && !isSharedRow(item))) return '';
		const top = item.row.briefTop;
		if (!top?.top || top.top.bucket === 'waitingOnOthers' || top.top.responsibility === 'them') {
			return '';
		}
		const chip = briefMoreChip(top.forYou);
		return chip ? t(chip.key, { count: chip.count }) : '';
	}

	function answerDueAt(item: AnswerItem): number | null {
		const at = item.source === 'mail' ? item.row.briefTop?.top?.dueAt : teamTopOf(item)?.dueAt;
		return at ?? null;
	}

	/** What kind of answer it is, beside when it arrived. */
	function answerMeta(item: AnswerItem): string {
		if (item.source === 'mail' && item.row.hasDraftSlot)
			return t('components.today.answer.draftReady');
		if (
			item.source === 'team' &&
			item.entry.message.processingStatus === 'awaiting_clarification'
		) {
			return t('components.today.answer.question');
		}
		if (item.source === 'team' && item.entry.message.draftResponse?.trim()) {
			return t('components.today.answer.draftReady');
		}
		if (item.source === 'mention') return t('components.today.answer.mention');
		return '';
	}

	/** A personal mailbox's to-do row reads like plain mail with the brief off. */
	function isPlainTodo(row: WorkTodoRow): boolean {
		return !autoSummarize.value && byId.value.get(row.mailboxId as never)?.scope !== 'shared';
	}
	function todoTitle(row: WorkTodoRow): string {
		if (isPlainTodo(row)) return row.subject || t('components.shell.noSubject');
		return locale.value.toLowerCase().startsWith('de') ? row.text.de : row.text.en;
	}
	function todoDetail(row: WorkTodoRow): string {
		const from = row.fromName || row.fromAddress;
		return (isPlainTodo(row) ? [from] : [from, row.subject]).filter(Boolean).join(' · ');
	}
	function todoMore(row: WorkTodoRow): string {
		if (isPlainTodo(row)) return '';
		const chip = briefMoreChip(row.count);
		return chip ? t(chip.key, { count: chip.count }) : '';
	}

	function dueLabel(at: number | null): string | null {
		return at === null
			? null
			: t('components.brief.item.due', { date: briefDueDate(at, locale.value) });
	}

	return {
		answerTitle,
		answerDetail,
		answerMore,
		answerDueAt,
		answerMeta,
		todoTitle,
		todoDetail,
		todoMore,
		dueLabel,
	};
}
