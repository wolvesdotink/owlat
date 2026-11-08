import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { TaskStatus, TaskView } from '~/types/tasks';

/**
 * Finishing, dropping, reopening and restoring a task, each with a toast whose
 * Undo puts the task back the way it was. `hide` / `unhide` let a list take
 * the row out at once and bring it back when the change fails or is undone.
 */
export function useTaskActions(
	options: {
		/** Called before the change goes out, with the status the task is moving to. */
		hide?: (id: Id<'tasks'>, next: TaskStatus) => void;
		unhide?: (id: Id<'tasks'>) => void;
	} = {}
) {
	const { t } = useI18n();
	const { showToast } = useToast();
	const { run } = useBackendOperation(api.tasks.mutations.setStatus, {
		label: () => t('components.tasks.operations.setStatus'),
	});

	function toastFor(next: TaskStatus, previous: TaskStatus): string {
		if (next === 'done') return t('components.tasks.toast.done');
		if (next === 'dropped') return t('components.tasks.toast.dropped');
		return previous === 'dropped'
			? t('components.tasks.toast.restored')
			: t('components.tasks.toast.reopened');
	}

	async function setStatus(
		task: Pick<TaskView, '_id' | 'status'>,
		status: TaskStatus
	): Promise<boolean> {
		const previous = task.status;
		if (previous === status) return true;
		const id = task._id;
		options.hide?.(id, status);
		const result = await run({ taskId: id, status });
		if (!result.ok) {
			options.unhide?.(id);
			return false;
		}
		showToast(toastFor(status, previous), 'success', {
			action: {
				label: t('common.undo'),
				onAction: async () => {
					const undone = await run({ taskId: id, status: previous });
					if (undone.ok) options.unhide?.(id);
				},
			},
		});
		return true;
	}

	/** Done for an open task, open again for a finished one. */
	function toggleDone(task: Pick<TaskView, '_id' | 'status'>): Promise<boolean> {
		return setStatus(task, task.status === 'open' ? 'done' : 'open');
	}

	return { setStatus, toggleDone };
}
