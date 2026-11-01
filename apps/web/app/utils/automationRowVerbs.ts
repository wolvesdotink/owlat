/**
 * The verbs an automation row offers, in menu order: the one list the row's
 * overflow menu (RowActions.vue) and its context menu (right-click, long-press)
 * both render, so the two can never disagree about what a row allows.
 *
 * Every write needs `automations:manage`, so an editor keeps only "View
 * details", which a draft does not have (it has never run, so there are no
 * analytics). A draft cannot be paused or activated, and a running automation
 * cannot be deleted. Module scope never calls `useI18n`, so `labelKey` is a
 * catalog key resolved at the render boundary.
 */
import {
	CopyIcon,
	PauseIcon,
	PencilIcon,
	PlayIcon,
	TrashIcon,
	ZapIcon,
	type IconComponent,
} from '@coolicons/vue';

export type AutomationRowVerbId = 'view' | 'edit' | 'duplicate' | 'toggle' | 'delete';

export interface AutomationRowVerb {
	readonly id: AutomationRowVerbId;
	readonly labelKey: string;
	readonly icon: IconComponent;
	readonly danger?: true;
	/** Draw a divider above this verb (it starts the destructive group). */
	readonly separatorBefore?: true;
}

export function automationRowVerbs(
	status: 'draft' | 'active' | 'paused',
	canManage: boolean
): AutomationRowVerb[] {
	const isDraft = status === 'draft';
	const isActive = status === 'active';
	const verbs: AutomationRowVerb[] = [];
	if (!isDraft) {
		verbs.push({
			id: 'view',
			labelKey: 'dashboard.automations.index.actions.viewDetails',
			icon: ZapIcon,
		});
	}
	if (!canManage) return verbs;
	verbs.push(
		{ id: 'edit', labelKey: 'common.edit', icon: PencilIcon },
		{ id: 'duplicate', labelKey: 'common.duplicate', icon: CopyIcon }
	);
	if (!isDraft) {
		verbs.push({
			id: 'toggle',
			labelKey: isActive
				? 'dashboard.automations.index.actions.pause'
				: 'dashboard.automations.index.actions.activate',
			icon: isActive ? PauseIcon : PlayIcon,
		});
	}
	if (!isActive) {
		verbs.push({
			id: 'delete',
			labelKey: 'common.delete',
			icon: TrashIcon,
			danger: true,
			separatorBefore: true,
		});
	}
	return verbs;
}

/**
 * Where an automation row's name leads: a draft opens the builder, anything
 * else its detail page. A draft has no detail page (it has never run), so for
 * a caller without `automations:manage` a draft leads nowhere (`null`). The
 * name link and the row menu's link verbs both read this, so a copied link is
 * always one the row itself offers.
 */
export function automationRowHref(
	automation: { _id: string; status: 'draft' | 'active' | 'paused' },
	canManage: boolean
): string | null {
	if (automation.status !== 'draft') return `/dashboard/automations/${automation._id}`;
	return canManage ? `/dashboard/automations/${automation._id}/edit` : null;
}
