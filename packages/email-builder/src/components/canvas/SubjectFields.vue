<script setup lang="ts">
import { computed, useId } from 'vue';
import { PlusIcon, TriangleWarningIcon } from '@coolicons/vue';
import UiTooltip from '@owlat/ui/components/ui/Tooltip.vue';
import type { Variable } from '../../types';
import VariablePlaceholderTag from '../ui/VariablePlaceholderTag.vue';
import VariableLineInput from './VariableLineInput.vue';
import UnknownVariablesHint from './UnknownVariablesHint.vue';
import { unknownSubjectVariables } from '../../utils/subjectVariables';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

/** The length an inbox shows of the preview text, as on the marketing settings page. */
const PREVIEW_TEXT_MAX_LENGTH = 150;

const props = defineProps<{
	name: string;
	subject: string;
	hideSubject: boolean;
	mode?: string;
	// Variables the subject line can reference. Feeds the `{{` picker and the
	// insert button; the send path personalizes the subject with the same keys.
	variables?: Variable[];
	// When set, render the data-variable manager strip. Only the transactional
	// editor (variableType: 'data') passes these — marketing personalization
	// variables come from contact fields and are not user-defined here.
	showDataVariables?: boolean;
	dataVariables?: Variable[];
	// The inbox preview line. Its row shows only when the host edits it here;
	// the send personalizes its tokens like the subject's.
	previewText?: string;
}>();

const emit = defineEmits<{
	(e: 'update:name', value: string): void;
	(e: 'update:subject', value: string): void;
	(e: 'update:previewText', value: string): void;
	/** Open the define-variable dialog, optionally prefilled with a key. */
	(e: 'add-variable', key?: string): void;
}>();

const nameId = useId();
const subjectId = useId();
const hintId = useId();
const previewTextId = useId();
const previewTextHintId = useId();

const lineVariables = computed(() => props.variables ?? []);
const canInsertVariables = computed(() => lineVariables.value.length > 0);

// Only a data-variable email declares its full key set; for any other editor
// a key missing from `variables` is not evidence of a typo.
function unknownKeysIn(text: string): string[] {
	return props.showDataVariables
		? unknownSubjectVariables(
				text,
				lineVariables.value.map((v) => v.key)
			)
		: [];
}
const unknownKeys = computed(() => unknownKeysIn(props.subject));
const unknownPreviewKeys = computed(() => unknownKeysIn(props.previewText ?? ''));
const isSubjectEmpty = computed(() => props.subject.trim() === '');
const showPreviewText = computed(() => !props.hideSubject && props.previewText !== undefined);

const nameLabel = computed(() =>
	props.mode === 'block' ? t('builder.header.blockName') : t('builder.header.templateName')
);

const subjectPlaceholder = computed(() =>
	canInsertVariables.value
		? t('builder.subject.placeholderWithVariables')
		: t('builder.header.subject')
);
const previewTextPlaceholder = computed(() =>
	canInsertVariables.value
		? t('builder.subject.previewTextPlaceholderWithVariables')
		: t('builder.subject.previewTextPlaceholder')
);
</script>

<template>
	<div
		data-testid="subject-fields"
		class="flex flex-col gap-2 pb-4 mb-2 border-b border-border-subtle"
	>
		<div class="flex items-center gap-3">
			<label :for="nameId" class="text-xs font-medium text-text-secondary w-16 shrink-0 text-right">
				{{ t('builder.subject.name') }}
			</label>
			<input
				:id="nameId"
				:value="name"
				type="text"
				:aria-label="nameLabel"
				class="flex-1 min-w-0 rounded-md border border-transparent bg-transparent px-2 py-1 text-text-primary font-medium text-sm focus:outline-none hover:border-border-default focus:border-brand transition-colors"
				:placeholder="nameLabel"
				@input="emit('update:name', ($event.target as HTMLInputElement).value)"
			/>
		</div>
		<div v-if="!hideSubject" class="flex items-start gap-3">
			<label
				:for="subjectId"
				class="text-xs font-medium text-text-secondary w-16 shrink-0 text-right pt-[7px]"
			>
				{{ t('builder.subject.subject') }}
			</label>
			<div class="flex-1 min-w-0">
				<VariableLineInput
					:id="subjectId"
					:value="subject"
					:variables="lineVariables"
					:field-label="t('builder.header.subject')"
					:placeholder="subjectPlaceholder"
					:insert-title="t('builder.subject.insertVariableTitle')"
					:insert-label="t('builder.subject.insertVariable')"
					test-id="subject-insert-variable"
					:warn="isSubjectEmpty || unknownKeys.length > 0"
					:described-by="isSubjectEmpty || unknownKeys.length ? hintId : undefined"
					@update:value="emit('update:subject', $event)"
				/>

				<p
					v-if="isSubjectEmpty"
					:id="hintId"
					class="mt-1 flex items-center gap-1 text-xs text-warning"
				>
					<TriangleWarningIcon :size="12" class="shrink-0" />
					{{ t('builder.subject.empty') }}
				</p>
				<UnknownVariablesHint
					v-else-if="unknownKeys.length"
					:id="hintId"
					:keys="unknownKeys"
					@add-variable="emit('add-variable', $event)"
				/>
			</div>
		</div>
		<div v-if="showPreviewText" class="flex items-start gap-3">
			<label
				:for="previewTextId"
				class="text-xs font-medium text-text-secondary w-16 shrink-0 text-right pt-[7px]"
			>
				{{ t('builder.subject.previewText') }}
			</label>
			<div class="flex-1 min-w-0">
				<VariableLineInput
					:id="previewTextId"
					:value="previewText ?? ''"
					:variables="lineVariables"
					:field-label="t('builder.subject.previewTextLabel')"
					:placeholder="previewTextPlaceholder"
					:insert-title="t('builder.subject.previewTextInsertVariableTitle')"
					:insert-label="t('builder.subject.previewTextInsertVariable')"
					test-id="preview-text-insert-variable"
					:warn="unknownPreviewKeys.length > 0"
					:described-by="unknownPreviewKeys.length ? previewTextHintId : undefined"
					:max-length="PREVIEW_TEXT_MAX_LENGTH"
					@update:value="emit('update:previewText', $event)"
				/>
				<UnknownVariablesHint
					v-if="unknownPreviewKeys.length"
					:id="previewTextHintId"
					:keys="unknownPreviewKeys"
					@add-variable="emit('add-variable', $event)"
				/>
			</div>
		</div>

		<!-- Data variables manager — the only in-editor affordance to DEFINE a new
		     data variable. Without it a freshly created transactional email has an
		     empty schema and the user can reference variables but never add one. -->
		<div v-if="showDataVariables" class="flex items-baseline gap-3 pt-1">
			<label class="text-xs font-medium text-text-secondary w-16 shrink-0 text-right">{{
				t('builder.variables.title')
			}}</label>
			<div class="flex-1 flex flex-wrap items-center gap-1.5">
				<VariablePlaceholderTag
					v-for="variable in dataVariables"
					:key="variable.key"
					:label="variable.key"
				/>
				<UiTooltip :text="t('builder.subject.newVariableTitle')">
					<button
						type="button"
						class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-dashed border-border-default text-xs text-text-secondary hover:bg-bg-surface-hover hover:text-text-primary hover:border-border-strong transition-colors"
						@click="emit('add-variable')"
					>
						<PlusIcon :size="12" />
						{{ t('builder.subject.newVariable') }}
					</button>
				</UiTooltip>
			</div>
		</div>
	</div>
</template>
