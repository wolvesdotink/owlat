<script setup lang="ts">
/**
 * "You archive everything from noreply@x. Always archive it?" (idea 27).
 *
 * A quiet strip at the FOOT of the reader — under the conversation, never over
 * it — because it is an observation about the sender, not about this message.
 * It renders in exactly two states and nothing else:
 *
 *   - an OFFER, when the sender's tally earned one. Two buttons, no default, no
 *     countdown, nothing that applies on its own.
 *   - the RULE it became, with a link to it in Filters and an undo. The link is
 *     what makes accepting honest: the rule is an ordinary filter from that
 *     moment, editable and deletable like any other.
 *
 * Renders nothing at all the rest of the time, which is almost always.
 */
import type { Id } from '@owlat/api/dataModel';
import { postboxFilterRuleLink, postboxTriageVerbCopy } from '~/utils/postboxTriageSuggestion';

const props = defineProps<{ messageId: string }>();

const { t } = useI18n();
const { senderAddress, suggestion, accepted, accept, dismiss, undo, isBusy } =
	usePostboxTriageSuggestion(computed(() => props.messageId as Id<'mailMessages'>));

const offerCopy = computed(() =>
	suggestion.value ? postboxTriageVerbCopy(suggestion.value.verb) : null
);
</script>

<template>
	<section
		v-if="(suggestion && offerCopy) || accepted"
		class="mt-4 rounded border border-border-subtle bg-bg-surface px-3 py-2.5"
		:aria-label="t('components.postbox.postboxTriageSuggestion.label')"
	>
		<div v-if="suggestion && offerCopy" class="flex flex-wrap items-center gap-x-3 gap-y-2">
			<Icon :name="offerCopy.icon" class="w-4 h-4 flex-shrink-0 text-text-tertiary" />
			<p class="flex-1 min-w-40 text-sm text-text-secondary">
				{{ t(offerCopy.promptKey, { sender: senderAddress, count: suggestion.count }) }}
			</p>
			<div class="flex items-center gap-2">
				<UiButton variant="secondary" size="sm" :disabled="isBusy" @click="() => void accept()">
					{{ t(offerCopy.acceptKey) }}
				</UiButton>
				<UiButton variant="ghost" size="sm" :disabled="isBusy" @click="() => void dismiss()">
					{{ t('components.postbox.postboxTriageSuggestion.dismiss') }}
				</UiButton>
			</div>
		</div>

		<div v-else-if="accepted" class="flex flex-wrap items-center gap-x-3 gap-y-2">
			<Icon name="lucide:check" class="w-4 h-4 flex-shrink-0 text-success" />
			<p class="flex-1 min-w-40 text-sm text-text-secondary">
				{{ t('components.postbox.postboxTriageSuggestion.created', { rule: accepted.filterName }) }}
			</p>
			<div class="flex items-center gap-2">
				<NuxtLink
					:to="postboxFilterRuleLink(String(accepted.filterId))"
					class="text-sm text-brand hover:underline"
				>
					{{ t('components.postbox.postboxTriageSuggestion.viewRule') }}
				</NuxtLink>
				<UiButton variant="ghost" size="sm" :disabled="isBusy" @click="() => void undo()">
					{{ t('components.postbox.postboxTriageSuggestion.undo') }}
				</UiButton>
			</div>
		</div>
	</section>
</template>
