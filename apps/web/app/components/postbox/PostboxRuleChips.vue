<script setup lang="ts">
/**
 * One plain-language rule as a line of chips (read on arrival):
 * its conditions joined by "and"/"or", its AI question, an arrow, then what
 * it does. Used for a compiled draft and for a saved rule, so the person sees
 * the same thing before and after saving.
 */

import type { Id } from '@owlat/api/dataModel';
import type {
	FilterAction,
	FilterMatchType,
	MailFilterCondition,
} from '~/composables/postbox/usePostboxFilters';

const props = defineProps<{
	conditions: MailFilterCondition[];
	matchType?: FilterMatchType;
	aiQuestion?: string;
	actions: FilterAction[];
	folderName: (id: Id<'mailFolders'>) => string | undefined;
	labelName: (id: Id<'mailLabels'>) => string | undefined;
}>();

const { t } = useI18n();

const FIELD_KEY = 'components.postbox.postboxFilterRuleBuilder.fields.';
const OP_KEY = 'components.postbox.postboxFilterRuleBuilder.ops.';
const ACTION_KEY = 'components.postbox.postboxFilterRuleBuilder.actions.';

function conditionText(condition: MailFilterCondition): string {
	const field = t(FIELD_KEY + condition.field);
	if (condition.field === 'hasAttachment') return field;
	if (condition.op === 'greaterThan' || condition.op === 'lessThan') {
		const sign = condition.op === 'greaterThan' ? '>' : '<';
		return `${field} ${sign} ${condition.valueNumber ?? 0}`;
	}
	return t('postbox.rules.chips.condition', {
		field,
		op: t(OP_KEY + condition.op),
		value: condition.value ?? '',
	});
}

function actionText(action: FilterAction): string {
	if (action.type === 'moveToFolder' && action.folderId) {
		const folder = props.folderName(action.folderId);
		if (folder) return t('postbox.rules.chips.moveTo', { folder });
	}
	if (action.type === 'addLabel' && action.labelId) {
		const label = props.labelName(action.labelId);
		if (label) return t('postbox.rules.chips.label', { label });
	}
	if (action.type === 'pinToSection' && action.sectionName) {
		return t('postbox.rules.chips.section', { section: action.sectionName });
	}
	if (action.type === 'archiveAfter' && action.hours) {
		return t('postbox.rules.chips.archiveAfter', { hours: action.hours });
	}
	return t(ACTION_KEY + action.type);
}

const joiner = computed(() =>
	t(props.matchType === 'any' ? 'postbox.rules.chips.or' : 'postbox.rules.chips.and')
);
</script>

<template>
	<div class="flex flex-wrap items-center gap-1.5 text-xs">
		<template v-for="(condition, index) in conditions" :key="`c${index}`">
			<span v-if="index > 0" class="text-text-tertiary">{{ joiner }}</span>
			<span class="rounded-full border border-border-subtle bg-bg-surface px-2 py-0.5">
				{{ conditionText(condition) }}
			</span>
		</template>
		<span v-if="aiQuestion && conditions.length > 0" class="text-text-tertiary">
			{{ t('postbox.rules.chips.and') }}
		</span>
		<span
			v-if="aiQuestion"
			class="rounded-full border border-brand/30 bg-brand/10 px-2 py-0.5 text-brand"
		>
			{{ t('postbox.rules.chips.ai', { question: aiQuestion }) }}
		</span>
		<span class="text-text-tertiary" aria-hidden="true">→</span>
		<span
			v-for="(action, index) in actions"
			:key="`a${index}`"
			class="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5"
		>
			{{ actionText(action) }}
		</span>
	</div>
</template>
