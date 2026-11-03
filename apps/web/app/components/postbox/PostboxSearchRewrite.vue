<script setup lang="ts">
/**
 * The "Search for: …" offer under a plain-language search that found little.
 *
 * Nothing is asked of the model until the person clicks: the search page shows
 * this on every settled plain-words query with few results, and an automatic
 * call there would spend on searches nobody wanted rewritten. The suggestion
 * lands in an editable field rather than running at once, so the person sees
 * the operators, can fix a wrong guess (a sender the model could not know, a
 * date range off by a month) and learns the syntax for next time.
 *
 * The page decides when this shows (`isSearchRewriteOffered`) and only mounts
 * it while the `ai` flag is on.
 */
import { api } from '@owlat/api';
import type { BudgetHoldReason } from '@owlat/shared/aiRouting';
import { BUDGET_REASON_KEYS, budgetReasonOf } from '~/utils/aiBudget';
import { localDayOf } from '~/utils/postboxDailyBrief';
import { SparklesIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const props = defineProps<{
	/** The plain-language query the search ran. */
	query: string;
}>();

const emit = defineEmits<{ search: [query: string] }>();

const { t } = useI18n();

type Outcome = 'idle' | 'ready' | 'none' | 'failed';
const outcome = ref<Outcome>('idle');
const suggestion = ref('');
/** The spend budget refused the call: said in place of the generic failure. */
const budgetReason = ref<BudgetHoldReason | null>(null);

const rewriteOp = useBackendOperation(api.mail.ai.searchRewrite.rewriteSearch, {
	label: () => t('components.postbox.postboxSearchRewrite.operation'),
	type: 'action',
	onError: (op) => {
		budgetReason.value = budgetReasonOf(op);
		return budgetReason.value !== null;
	},
});
const isBusy = computed(() => rewriteOp.isLoading.value);

async function suggest() {
	if (isBusy.value) return;
	budgetReason.value = null;
	const asked = props.query;
	const res = await rewriteOp.run({ query: asked, today: localDayOf(new Date()) });
	// The person searched for something else while the model was thinking.
	if (asked !== props.query) return;
	if (!res.ok) {
		outcome.value = budgetReason.value ? 'idle' : 'failed';
		return;
	}
	if (res.result.query) {
		suggestion.value = res.result.query;
		outcome.value = 'ready';
	} else {
		outcome.value = 'none';
	}
}

function runSuggestion() {
	// A search is one line: a newline pasted into the field is a space.
	const next = suggestion.value.replace(/\s+/g, ' ').trim();
	if (next) emit('search', next);
}

watch(
	() => props.query,
	() => {
		outcome.value = 'idle';
		suggestion.value = '';
		budgetReason.value = null;
	}
);
</script>

<template>
	<div
		class="rounded-lg border border-border-subtle bg-bg-elevated px-3 py-2 space-y-2"
		data-testid="search-rewrite"
	>
		<template v-if="outcome === 'ready'">
			<label for="search-rewrite-query" class="block text-xs font-medium text-text-secondary">
				{{ t('components.postbox.postboxSearchRewrite.searchFor') }}
			</label>
			<!-- A textarea so a long query wraps in the narrow results column and
			     stays readable in full; Enter still searches. -->
			<textarea
				id="search-rewrite-query"
				v-model="suggestion"
				rows="2"
				class="input input-sm w-full resize-none font-mono"
				data-testid="search-rewrite-query"
				@keydown.enter.exact.prevent="runSuggestion"
			/>
			<div class="flex items-start gap-2">
				<p class="flex-1 text-xs text-text-tertiary">
					{{ t('components.postbox.postboxSearchRewrite.editHint') }}
				</p>
				<UiButton
					variant="secondary"
					size="sm"
					:disabled="!suggestion.trim()"
					data-testid="search-rewrite-run"
					@click="runSuggestion"
				>
					{{ t('components.postbox.postboxSearchRewrite.search') }}
				</UiButton>
			</div>
		</template>
		<template v-else>
			<div class="flex items-start gap-2">
				<SparklesIcon class="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-tertiary" />
				<p class="flex-1 text-xs text-text-secondary">
					{{ t('components.postbox.postboxSearchRewrite.offer') }}
				</p>
			</div>
			<UiButton
				variant="secondary"
				size="sm"
				class="gap-1"
				:disabled="isBusy"
				data-testid="search-rewrite-suggest"
				@click="suggest"
			>
				<SpinnerIcon v-if="isBusy" class="h-3.5 w-3.5" />
				{{
					isBusy
						? t('components.postbox.postboxSearchRewrite.working')
						: t('components.postbox.postboxSearchRewrite.suggest')
				}}
			</UiButton>
			<div aria-live="polite">
				<p
					v-if="budgetReason"
					class="text-xs text-text-secondary"
					role="status"
					data-testid="search-rewrite-budget"
				>
					<span class="font-medium text-text-primary">{{ t('shared.aiBudget.title') }}</span>
					{{ ' ' }}{{ t(BUDGET_REASON_KEYS[budgetReason]) }}
				</p>
				<p
					v-else-if="outcome === 'none'"
					class="text-xs text-text-tertiary"
					data-testid="search-rewrite-none"
				>
					{{ t('components.postbox.postboxSearchRewrite.none') }}
				</p>
				<p v-else-if="outcome === 'failed'" class="text-xs text-text-tertiary">
					{{ t('components.postbox.postboxSearchRewrite.failed') }}
				</p>
			</div>
		</template>
	</div>
</template>
