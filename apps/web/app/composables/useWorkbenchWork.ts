import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { ComputedRef, Ref } from 'vue';
import type { AnswerItem } from '~/composables/useAnswerQueue';
import type { InboxIdentity } from '~/utils/inboxIdentity';
import { ALL_SCOPE, TEAM_SCOPE, type WorkbenchScope } from '~/utils/workbench';
import { buildWorkCards, taskInScope, type WorkTodoRow } from '~/utils/workbenchWork';

/**
 * What feeds the Workbench's "What needs you" besides the Answer queue: the
 * requests that need no reply, read per mailbox in the open tab (each read
 * keeps its own access check), and the viewer's tasks from that tab's inbox
 * (every task, hand-made ones included, on All).
 */
export function useWorkbenchWork(input: {
	scope: Ref<WorkbenchScope | null>;
	/** The open tab's mailbox; null on All and the team inbox. */
	inbox: Ref<InboxIdentity<Id<'mailboxes'>> | null>;
	/** The mailboxes All combines. */
	shownMailboxIds: Ref<readonly Id<'mailboxes'>[]>;
	answer: Ref<readonly AnswerItem[]>;
}) {
	const myTasks = useConvexQuery(api.tasks.tasks.list, { view: 'mine' });
	const scopedTasks = computed(() => {
		const scope = input.scope.value;
		if (!scope) return [];
		return (myTasks.data.value ?? []).filter((task) =>
			taskInScope(task, scope, ALL_SCOPE, TEAM_SCOPE)
		);
	});

	const todoMailboxIds = computed<Id<'mailboxes'>[]>(() => {
		if (input.scope.value === ALL_SCOPE) return [...input.shownMailboxIds.value];
		return input.inbox.value ? [input.inbox.value.mailboxId] : [];
	});
	const todoReads = useConvexQueryMap(
		api.mail.interpret.todo.listNoReplyToDo,
		todoMailboxIds,
		(mailboxId) => ({ mailboxId })
	);
	const scopedTodo = computed<WorkTodoRow[]>(() =>
		todoMailboxIds.value.flatMap((mailboxId) =>
			(todoReads.get(mailboxId)?.data.value?.rows ?? []).map((row) => ({
				...row,
				messageId: row.messageId ?? null,
				mailboxId,
			}))
		)
	);

	// The number on the lane: one per card, as TodayWork groups them.
	const workCount: ComputedRef<number> = computed(
		() =>
			buildWorkCards({
				answer: input.answer.value,
				todo: scopedTodo.value,
				tasks: scopedTasks.value,
				answerDueAt: () => null,
				now: 0,
			}).length
	);

	return { myTasks, scopedTasks, scopedTodo, workCount };
}
