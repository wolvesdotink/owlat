/**
 * Postbox filters composable — list / create / update / delete inbound
 * mail filters that run during delivery, plus the three things idea 39 added:
 * the match-any grouping, a writable run order, and the retroactive sweep over
 * mail that arrived before the rule existed.
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
	/** Split inbox (idea 24): file into a named inbox SECTION, moving nothing. */
	| 'pinToSection'
	| 'discard';

export interface MailFilterCondition {
	field: FilterField;
	headerName?: string;
	op: FilterOp;
	value?: string;
	valueNumber?: number;
}

/** One grouping level: `all` AND-s the conditions, `any` OR-s them. */
export type FilterMatchType = 'all' | 'any';

/**
 * Actions a RETROACTIVE run may perform. `forward`, `delete` and `discard` are
 * irreversible and were authored for the inbound moment, so the backend skips
 * them on a sweep; the UI reads the same set to say when a rule has nothing
 * safe to apply. Mirrors `SAFE_ACTION_TYPES` in mail/filterRun.ts.
 */
export const RETROACTIVE_ACTION_TYPES: readonly FilterActionType[] = [
	'moveToFolder',
	'addLabel',
	'markRead',
	'markFlagged',
	'pinToSection',
];

export function hasRetroactiveActions(actions: readonly FilterAction[]): boolean {
	return actions.some((action) => RETROACTIVE_ACTION_TYPES.includes(action.type));
}

export interface FilterAction {
	type: FilterActionType;
	folderId?: Id<'mailFolders'>;
	labelId?: Id<'mailLabels'>;
	forwardTo?: string;
	/** For `pinToSection` — the section name, which IS the section's identity. */
	sectionName?: string;
}

export function usePostboxFilters(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { t } = useI18n();
	const { data, isLoading } = useConvexQuery(api.mail.filters.list, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);
	const filters = computed(() => data.value ?? []);

	const createMutation = useBackendOperation(api.mail.filters.create, {
		label: () => t('shared.postbox.usePostboxFilters.createFilter'),
	});
	const updateMutation = useBackendOperation(api.mail.filters.update, {
		label: () => t('shared.postbox.usePostboxFilters.updateFilter'),
	});
	const removeMutation = useBackendOperation(api.mail.filters.remove, {
		label: () => t('shared.postbox.usePostboxFilters.deleteFilter'),
	});
	const reorderMutation = useBackendOperation(api.mail.filters.reorder, {
		label: () => t('shared.postbox.usePostboxFilters.reorderFilters'),
	});

	async function create(args: {
		name: string;
		conditions: MailFilterCondition[];
		actions: FilterAction[];
		matchType?: FilterMatchType;
		stopProcessing?: boolean;
	}) {
		if (!mailboxId.value) throw new Error('No mailbox');
		return createMutation.run({
			mailboxId: mailboxId.value,
			name: args.name,
			conditions: args.conditions,
			actions: args.actions,
			matchType: args.matchType,
			stopProcessing: args.stopProcessing,
		});
	}

	/** Write the whole run order — `priority` ascending is evaluation order. */
	async function reorder(filterIds: Id<'mailFilters'>[]) {
		if (!mailboxId.value) return;
		await reorderMutation.run({ mailboxId: mailboxId.value, filterIds });
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
			matchType?: FilterMatchType;
			stopProcessing?: boolean;
			priority?: number;
		}
	) {
		await updateMutation.run({ filterId, ...patch });
	}

	async function remove(filterId: Id<'mailFilters'>) {
		await removeMutation.run({ filterId });
	}

	return { filters, isLoading, create, update, setEnabled, remove, reorder };
}
