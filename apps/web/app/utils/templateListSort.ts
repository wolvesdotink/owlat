/**
 * The sort menu and status badge shared by the marketing and transactional
 * template lists.
 *
 * Both lists used to carry their own six-entry sort table under their own i18n
 * namespace, and their own `getStatusBadge` (one returning a resolved label,
 * the other a message key). One table and one badge now; the data layers still
 * differ on purpose: marketing sorts the loaded page client-side through
 * `sortTemplateRows`, transactional passes `sortBy`/`sortOrder` to its query.
 *
 * Every `label` here is an i18n message key, resolved with `t()` where it
 * renders — the tables are module scope, where no `t` exists.
 */

type TemplateSortField = 'updatedAt' | 'createdAt' | 'name';

export interface TemplateSortOption {
	/** i18n message key under `shared.templateList.sort`. */
	label: string;
	value: string;
	sortBy: TemplateSortField;
	sortOrder: 'asc' | 'desc';
}

export const TEMPLATE_SORT_OPTIONS: readonly TemplateSortOption[] = [
	{
		label: 'shared.templateList.sort.updatedDesc',
		value: 'updatedAt-desc',
		sortBy: 'updatedAt',
		sortOrder: 'desc',
	},
	{
		label: 'shared.templateList.sort.updatedAsc',
		value: 'updatedAt-asc',
		sortBy: 'updatedAt',
		sortOrder: 'asc',
	},
	{
		label: 'shared.templateList.sort.createdDesc',
		value: 'createdAt-desc',
		sortBy: 'createdAt',
		sortOrder: 'desc',
	},
	{
		label: 'shared.templateList.sort.createdAsc',
		value: 'createdAt-asc',
		sortBy: 'createdAt',
		sortOrder: 'asc',
	},
	{
		label: 'shared.templateList.sort.nameAsc',
		value: 'name-asc',
		sortBy: 'name',
		sortOrder: 'asc',
	},
	{
		label: 'shared.templateList.sort.nameDesc',
		value: 'name-desc',
		sortBy: 'name',
		sortOrder: 'desc',
	},
];

interface SortableTemplateRow {
	name: string;
	createdAt: number;
	updatedAt: number;
}

/** A sorted copy of `rows`; the input is left untouched. */
export function sortTemplateRows<T extends SortableTemplateRow>(
	rows: readonly T[],
	sort: Pick<TemplateSortOption, 'sortBy' | 'sortOrder'>
): T[] {
	const { sortBy, sortOrder } = sort;
	return [...rows].sort((a, b) => {
		let cmp: number;
		if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
		else if (sortBy === 'createdAt') cmp = a.createdAt - b.createdAt;
		else cmp = a.updatedAt - b.updatedAt;
		return sortOrder === 'desc' ? -cmp : cmp;
	});
}

/** Marketing templates are draft or published; transactional ones can also await review. */
export type TemplateStatus = 'draft' | 'published' | 'pending_review';

interface TemplateStatusBadge {
	color: string;
	icon: string;
	/** i18n message key under `shared.templateList.status`. */
	label: string;
}

const STATUS_BADGES: Record<TemplateStatus, TemplateStatusBadge> = {
	published: {
		color: 'bg-success/10 text-success',
		icon: 'lucide:check-circle',
		label: 'shared.templateList.status.published',
	},
	pending_review: {
		color: 'bg-warning/10 text-warning',
		icon: 'lucide:clock-3',
		label: 'shared.templateList.status.pendingReview',
	},
	draft: {
		color: 'bg-text-tertiary/10 text-text-tertiary',
		icon: 'lucide:file-text',
		label: 'shared.templateList.status.draft',
	},
};

export function templateStatusBadge(status: TemplateStatus): TemplateStatusBadge {
	return STATUS_BADGES[status] ?? STATUS_BADGES.draft;
}
