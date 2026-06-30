import { defineAsyncComponent } from 'vue';
import type { ConditionEditorModule, ConditionOfKind } from '../types';

type EmailActivityCondition = ConditionOfKind<'email_activity'>;

interface ActivityOption {
	field: EmailActivityCondition['field'];
	operator: EmailActivityCondition['operator'];
	label: string;
}

export const ACTIVITY_OPTIONS: ActivityOption[] = [
	{ field: 'opened', operator: 'is_true', label: 'Has opened an email' },
	{ field: 'clicked', operator: 'is_true', label: 'Has clicked a link' },
	{ field: 'opened', operator: 'is_false', label: 'Has not opened any email' },
	{ field: 'clicked', operator: 'is_false', label: 'Has not clicked any link' },
];

export function activityKey(c: EmailActivityCondition): string {
	return `${c.field}:${c.operator}`;
}

export const emailActivityEditorModule: ConditionEditorModule<'email_activity'> = {
	kind: 'email_activity',
	label: 'Email Activity',
	description: 'Filter by opens, clicks, etc.',
	createDefault: () => ({
		kind: 'email_activity',
		field: 'opened',
		operator: 'is_true',
	}),
	validateForSubmit(condition) {
		if (condition.field !== 'opened' && condition.field !== 'clicked') {
			return 'Please select an activity type';
		}
		return null;
	},
	getDescription(condition) {
		const match = ACTIVITY_OPTIONS.find(
			(o) => o.field === condition.field && o.operator === condition.operator
		);
		return match?.label ?? 'Configure email activity';
	},
	EditorComponent: defineAsyncComponent(
		() => import('../../../components/conditions/email_activity/Editor.vue')
	),
};
