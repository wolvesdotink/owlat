/**
 * Postbox filters composable — list / create / update / delete inbound
 * mail filters that run during delivery.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export type FilterField =
	| 'from'
	| 'to'
	| 'cc'
	| 'subject'
	| 'body'
	| 'header'
	| 'size'
	| 'hasAttachment';

export type FilterOp =
	| 'contains'
	| 'notContains'
	| 'equals'
	| 'matches'
	| 'greaterThan'
	| 'lessThan'
	| 'isTrue';

export type FilterActionType =
	| 'moveToFolder'
	| 'addLabel'
	| 'markRead'
	| 'markFlagged'
	| 'forward'
	| 'delete'
	| 'discard';

export interface MailFilterCondition {
	field: FilterField;
	headerName?: string;
	op: FilterOp;
	value?: string;
	valueNumber?: number;
}

export interface FilterAction {
	type: FilterActionType;
	folderId?: Id<'mailFolders'>;
	labelId?: Id<'mailLabels'>;
	forwardTo?: string;
}

export function usePostboxFilters(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { data, isLoading } = useConvexQuery(api.mail.filters.list, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);
	const filters = computed(() => data.value ?? []);

	const createMutation = useBackendOperation(api.mail.filters.create, {
		label: 'Create filter',
	});
	const updateMutation = useBackendOperation(api.mail.filters.update, {
		label: 'Update filter',
	});
	const removeMutation = useBackendOperation(api.mail.filters.remove, {
		label: 'Delete filter',
	});

	async function create(args: {
		name: string;
		conditions: MailFilterCondition[];
		actions: FilterAction[];
		stopProcessing?: boolean;
	}) {
		if (!mailboxId.value) throw new Error('No mailbox');
		return createMutation.run({
			mailboxId: mailboxId.value,
			name: args.name,
			conditions: args.conditions,
			actions: args.actions,
			stopProcessing: args.stopProcessing,
		});
	}

	async function setEnabled(filterId: Id<'mailFilters'>, enabled: boolean) {
		await updateMutation.run({ filterId, isEnabled: enabled });
	}

	async function update(
		filterId: Id<'mailFilters'>,
		patch: {
			name?: string;
			conditions?: MailFilterCondition[];
			actions?: FilterAction[];
			stopProcessing?: boolean;
			priority?: number;
		}
	) {
		await updateMutation.run({ filterId, ...patch });
	}

	async function remove(filterId: Id<'mailFilters'>) {
		await removeMutation.run({ filterId });
	}

	return { filters, isLoading, create, update, setEnabled, remove };
}
