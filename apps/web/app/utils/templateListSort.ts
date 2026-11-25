/**
 * The sort menu and status badge shared by the marketing and transactional
 * template lists. Both pass the option's `sortBy`/`sortOrder` to their query:
 * a paginated list sorted in the browser would only order the rows loaded so
 * far.
 *
 * Every `label` here is an i18n message key, resolved with `t()` where it
 * renders — the tables are module scope, where no `t` exists.
 */

import { CircleCheckIcon, ClockIcon, FileTextIcon, type IconComponent } from '@coolicons/vue';

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

/** Marketing templates are draft or published; transactional ones can also await review. */
export type TemplateStatus = 'draft' | 'published' | 'pending_review';

interface TemplateStatusBadge {
	color: string;
	icon: IconComponent;
	/** i18n message key under `shared.templateList.status`. */
	label: string;
}

const STATUS_BADGES: Record<TemplateStatus, TemplateStatusBadge> = {
	published: {
		color: 'bg-success/10 text-success',
		icon: CircleCheckIcon,
		label: 'shared.templateList.status.published',
	},
	pending_review: {
		color: 'bg-warning/10 text-warning',
		icon: ClockIcon,
		label: 'shared.templateList.status.pendingReview',
	},
	draft: {
		color: 'bg-text-tertiary/10 text-text-tertiary',
		icon: FileTextIcon,
		label: 'shared.templateList.status.draft',
	},
};

export function templateStatusBadge(status: TemplateStatus): TemplateStatusBadge {
	return STATUS_BADGES[status] ?? STATUS_BADGES.draft;
}
