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
export type AutomationRowVerbId = 'view' | 'edit' | 'duplicate' | 'toggle' | 'delete';

export interface AutomationRowVerb {
	readonly id: AutomationRowVerbId;
	readonly labelKey: string;
	readonly icon: string;
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
			icon: 'lucide:zap',
		});
	}
	if (!canManage) return verbs;
	verbs.push(
		{ id: 'edit', labelKey: 'common.edit', icon: 'lucide:pencil' },
		{ id: 'duplicate', labelKey: 'common.duplicate', icon: 'lucide:copy' }
	);
	if (!isDraft) {
		verbs.push({
			id: 'toggle',
			labelKey: isActive
				? 'dashboard.automations.index.actions.pause'
				: 'dashboard.automations.index.actions.activate',
			icon: isActive ? 'lucide:pause' : 'lucide:play',
		});
	}
	if (!isActive) {
		verbs.push({
			id: 'delete',
			labelKey: 'common.delete',
			icon: 'lucide:trash-2',
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
