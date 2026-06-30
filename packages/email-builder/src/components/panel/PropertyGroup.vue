<script setup lang="ts">
import { ref } from 'vue';
import type { PropertyGroup } from '../../schema/types';
import type { EditorBlock, Variable, EmailTheme } from '../../types';
import PropertyField from './PropertyField.vue';
import { ChevronDown } from '@lucide/vue';
import { resolveGroupIcon } from '../../schema/groupIcons';
import { getByPath } from '../../utils/propertyPath';

const props = defineProps<{
	group: PropertyGroup;
	block: EditorBlock;
	theme: Required<EmailTheme>;
	variables?: Variable[];
	onUploadImage?: (file: File) => Promise<{ url: string; storageId?: string }>;
	/** Hide the collapsible header (used when the parent already shows the group title) */
	hideHeader?: boolean;
}>();

const emit = defineEmits<{
	(e: 'update', key: string, value: unknown): void;
}>();

const isCollapsed = ref(props.group.collapsed ?? false);

const groupIcon = resolveGroupIcon(props.group);

function toggleCollapse() {
	isCollapsed.value = !isCollapsed.value;
}

function getFieldValue(key: string): unknown {
	// Support dot notation (e.g. 'labels.days')
	return getByPath(props.block.content, key);
}

function isFieldVisible(field: { showWhen?: { key: string; value: unknown } }): boolean {
	if (!field.showWhen) return true;
	const val = getFieldValue(field.showWhen.key);
	// For truthy checks (showWhen: { key: 'x', value: true }), check truthiness
	if (field.showWhen.value === true) return !!val;
	return val === field.showWhen.value;
}
</script>

<template>
	<div
		class="border-b border-border-subtle transition-colors duration-200"
	>
		<button
			v-if="!hideHeader"
			class="flex items-center justify-between w-full py-2.5 pr-4 pl-4 bg-none border-none cursor-pointer select-none transition-colors duration-[120ms] hover:bg-bg-surface-hover active:bg-bg-surface-hover"
			type="button"
			@click="toggleCollapse"
		>
			<div class="flex items-center gap-1.5">
				<component
					:is="groupIcon"
					:size="11"
					class="shrink-0 transition-colors duration-200"
					:class="!isCollapsed && !hideHeader ? 'text-text-secondary' : 'text-text-disabled'"
				/>
				<span class="text-[10px] font-semibold uppercase tracking-[0.08em]" :class="!isCollapsed && !hideHeader ? 'text-text-secondary' : 'text-text-tertiary'">{{ group.label }}</span>
			</div>
			<ChevronDown
				class="text-text-disabled transition-transform duration-250 ease-[cubic-bezier(0.4,0,0.2,1)]"
				:class="{ '-rotate-90': isCollapsed }"
				:size="12"
			/>
		</button>

		<div
			v-show="hideHeader || !isCollapsed"
		>
			<div
				class="px-4 pb-4 flex flex-col gap-[14px]"
				:class="hideHeader ? 'pt-3' : 'pt-0.5'"
			>
				<template v-for="field in group.fields" :key="field.key">
					<PropertyField
						v-if="isFieldVisible(field)"
						:field="field"
						:value="getFieldValue(field.key)"
						:block="block"
						:theme="theme"
						:variables="variables"
						:on-upload-image="onUploadImage"
						@update="(value) => emit('update', field.key, value)"
						@update-keyed="(key, value) => emit('update', key, value)"
					/>
				</template>
			</div>
		</div>
	</div>
</template>
