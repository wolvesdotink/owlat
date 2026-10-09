<script setup lang="ts">
/**
 * The team reply's response plan, beside the composer (plan §6): what the
 * reply covers among the thread's open actions, each selected item with its
 * stance (Accept / Decline / Defer / Ask, or Answer / Decline / Defer) and,
 * once the draft was checked, "Addressed in draft" or "File missing"; and the
 * file-claim banner. The thread's stream and its pinned "Open for the team"
 * list are the conversation column's; this is only the reply's side of them.
 *
 * Shown with the `ai` flag on (the plan's coverage is a model check). Folds
 * to its heading line ("Your reply covers · 3 of 4 selected"); open by
 * default while the list is short.
 */
import { provide } from 'vue';
import type { BriefItemView } from '../../../../api/convex/mail/interpret/briefShape';
import { BRIEF_CONTEXT } from '~/utils/threadBriefContext';
import { RESPONSE_PLAN } from '~/utils/responsePlan';
import type { ResponsePlan } from '~/composables/useResponsePlan';
import BriefItems from '~/components/brief/BriefItems.vue';
import AnswerPlanBanner from './AnswerPlanBanner.vue';

const props = defineProps<{
	/** The reply's plan; its `items` are the thread's open items it plans for. */
	plan: ResponsePlan;
	canAttach: boolean;
}>();

const emit = defineEmits<{ files: [files: File[]] }>();

const { t } = useI18n();
const { isEnabled } = useFeatureFlag();

provide(RESPONSE_PLAN, props.plan.view);
// Item sources are the conversation column's to show; nothing to reveal here.
provide(BRIEF_CONTEXT, { sourceOf: () => undefined, cite: () => {} });

const items = computed(() => props.plan.items.value);
const open = ref(items.value.length <= 4);
const selectedSet = computed(() => new Set(props.plan.selected.value));
const ours = computed(() => items.value.filter((i) => i.responsibility !== 'unclear'));
const unclear = computed(() => items.value.filter((i) => i.responsibility === 'unclear'));

/** Hand the picked files to the reply, and check the draft again once they land. */
function onFiles(list: File[]) {
	emit('files', list);
	props.plan.recheck();
}

function toggle(item: BriefItemView) {
	const next = new Set(selectedSet.value);
	if (next.has(item.id)) next.delete(item.id);
	else next.add(item.id);
	props.plan.setSelected([...next]);
}
</script>

<template>
	<section
		v-if="isEnabled('ai') && (items.length > 0 || plan.missingFiles.value.length > 0)"
		class="border-b border-border-subtle"
		data-testid="answer-team-plan"
	>
		<button
			v-if="items.length > 0"
			type="button"
			class="flex w-full items-center gap-2 px-3 pt-3 text-left text-xs text-text-secondary"
			:aria-expanded="open"
			data-testid="answer-team-plan-toggle"
			@click="open = !open"
		>
			<span class="font-medium text-text-primary">{{ t('components.answer.plan.title') }}</span>
			<span>
				{{
					t('components.answer.plan.selected', {
						count: plan.selected.value.length,
						total: items.length,
					})
				}}
			</span>
			<Icon
				:name="open ? 'lucide:chevron-up' : 'lucide:chevron-down'"
				class="ml-auto size-3.5 text-text-tertiary"
				aria-hidden="true"
			/>
		</button>
		<div v-if="open && items.length > 0" class="px-3 pb-2 pt-1">
			<BriefItems
				kind="forTeam"
				:items="ours"
				selectable
				:selected="selectedSet"
				compact
				hide-actions
				@toggle-select="toggle"
			/>
			<BriefItems
				kind="unclear"
				:items="unclear"
				selectable
				:selected="selectedSet"
				compact
				hide-actions
				@toggle-select="toggle"
			/>
		</div>
		<AnswerPlanBanner
			class="mb-3"
			:claims="plan.missingFiles.value"
			:can-attach="canAttach"
			@files="onFiles"
		/>
	</section>
</template>
