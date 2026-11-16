<script setup lang="ts">
/**
 * "Use as reference": search the organisation's templates, transactional
 * emails and campaigns by name, and keep up to three picks as removable
 * chips. The picks are sent with the generation request; the server reads
 * them with the caller's own access rules.
 */
import { api } from '@owlat/api';
import { CloseIcon, SearchIcon } from '@coolicons/vue';
import { addReference, MAX_REFERENCES, removeReference, type EmailReference } from '~/lib/emailGeneration';

const references = defineModel<EmailReference[]>({ required: true });
const props = defineProps<{ disabled?: boolean }>();

const { t } = useI18n();
const inputId = useId();
const listId = useId();

const query = ref('');
const debounced = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
watch(query, (value) => {
	clearTimeout(timer);
	timer = setTimeout(() => (debounced.value = value.trim()), 250);
});
onBeforeUnmount(() => clearTimeout(timer));

const { data: options, isLoading } = useConvexQuery(
	api.emailGeneration.context.searchReferences,
	() => (debounced.value.length >= 2 ? { query: debounced.value } : 'skip')
);

const isFull = computed(() => references.value.length >= MAX_REFERENCES);
const visibleOptions = computed(() =>
	(options.value ?? []).filter((o) => !references.value.some((r) => r.id === o.id))
);
const showList = computed(() => debounced.value.length >= 2 && !isFull.value && query.value.trim() !== '');

const KIND_KEYS = {
	template: 'components.ai.emailGenerate.references.kind.template',
	transactional: 'components.ai.emailGenerate.references.kind.transactional',
	campaign: 'components.ai.emailGenerate.references.kind.campaign',
} as const;

function pick(option: { kind: EmailReference['kind']; id: string; name: string }) {
	references.value = addReference(references.value, { kind: option.kind, id: option.id, name: option.name });
	query.value = '';
	debounced.value = '';
}

function remove(id: string) {
	references.value = removeReference(references.value, id);
}
</script>

<template>
	<div>
		<label :for="inputId" class="block text-sm font-medium text-text-secondary mb-1.5">
			{{ t('components.ai.emailGenerate.references.label') }}
			<span class="font-normal text-text-tertiary">
				{{ t('components.ai.emailGenerate.references.optional') }}
			</span>
		</label>

		<ul v-if="references.length > 0" class="flex flex-wrap gap-2 mb-2" data-testid="reference-chips">
			<li
				v-for="ref in references"
				:key="ref.id"
				class="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-subtle bg-bg-surface py-1 pl-3 pr-1 text-sm text-text-primary"
			>
				<span class="text-xs text-text-tertiary shrink-0">{{ t(KIND_KEYS[ref.kind]) }}</span>
				<span class="truncate">{{ ref.name }}</span>
				<button
					type="button"
					class="rounded-full p-0.5 text-text-tertiary hover:bg-bg-elevated hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
					:aria-label="t('components.ai.emailGenerate.references.remove', { name: ref.name })"
					:disabled="props.disabled"
					@click="remove(ref.id)"
				>
					<CloseIcon class="h-3.5 w-3.5" aria-hidden="true" />
				</button>
			</li>
		</ul>

		<div class="relative">
			<SearchIcon
				class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary"
				aria-hidden="true"
			/>
			<input
				:id="inputId"
				v-model="query"
				type="search"
				class="input pl-9"
				autocomplete="off"
				role="combobox"
				:aria-expanded="showList"
				:aria-controls="listId"
				:disabled="props.disabled || isFull"
				:placeholder="
					isFull
						? t('components.ai.emailGenerate.references.full', { max: MAX_REFERENCES })
						: t('components.ai.emailGenerate.references.placeholder')
				"
				@keydown.esc.stop="query = ''"
			/>
			<ul
				v-if="showList"
				:id="listId"
				role="listbox"
				class="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border-subtle bg-bg-elevated py-1 shadow-surface-3"
			>
				<li v-if="isLoading && visibleOptions.length === 0" class="px-3 py-2 text-sm text-text-tertiary">
					{{ t('components.ai.emailGenerate.references.searching') }}
				</li>
				<li v-else-if="visibleOptions.length === 0" class="px-3 py-2 text-sm text-text-tertiary">
					{{ t('components.ai.emailGenerate.references.noMatches') }}
				</li>
				<li v-for="option in visibleOptions" :key="option.id" role="option" :aria-selected="false">
					<button
						type="button"
						class="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-bg-surface focus-visible:bg-bg-surface focus-visible:outline-none"
						@click="pick(option)"
					>
						<span class="flex w-full items-center gap-2 text-sm text-text-primary">
							<span class="truncate">{{ option.name }}</span>
							<span class="ml-auto shrink-0 text-xs text-text-tertiary">{{ t(KIND_KEYS[option.kind]) }}</span>
						</span>
						<span v-if="option.subject" class="w-full truncate text-xs text-text-tertiary">
							{{ option.subject }}
						</span>
					</button>
				</li>
			</ul>
		</div>
	</div>
</template>
