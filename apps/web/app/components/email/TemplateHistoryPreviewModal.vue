<script setup lang="ts">
import { GitCompareIcon, HistoryIcon, RotateLeftIcon } from '@coolicons/vue';

/**
 * One saved snapshot of an email template, rendered read-only, with the way to
 * compare it with the editor or restore it. {@link TemplateHistoryPanel} owns
 * loading the snapshot and what Compare and Restore do.
 */
defineProps<{
	/** The snapshot on screen; null once the preview closes. */
	version: { name: string; subject: string; createdAt: number } | null;
	/** What made the snapshot ("Saved", "Published"), already translated. */
	triggerLabel: string;
	/** The snapshot rendered to email HTML. */
	html: string;
	loading: boolean;
	/** The editor can hand over its current state, so Compare is offered. */
	canCompare: boolean;
	restoring: boolean;
}>();

const emit = defineEmits<{ compare: []; restore: [] }>();

const open = defineModel<boolean>('open', { required: true });

const { t } = useI18n();
const titleId = useId();
</script>

<template>
	<UiModal v-model:open="open" size="3xl" :labelled-by="titleId">
		<div class="flex items-center gap-3 mb-4">
			<UiIconBox :icon="HistoryIcon" size="sm" variant="brand" rounded="lg" />
			<div class="min-w-0">
				<h2 :id="titleId" class="text-lg font-semibold text-text-primary truncate">
					{{ version?.name }}
				</h2>
				<p class="text-sm text-text-secondary truncate">
					{{ triggerLabel }}
					{{ version ? formatRelativeTime(version.createdAt) : '' }}
					&middot; {{ version?.subject }}
				</p>
			</div>
		</div>

		<div
			class="h-[60vh] rounded-lg border border-border-subtle overflow-hidden bg-bg-deep flex items-center justify-center"
		>
			<UiSpinner v-if="loading" />
			<!-- palette-ok-start: the paper stays literally white in both app themes —
			     the snapshot's own HTML carries its (light) colors, so a theme token
			     here would only show as a mismatched flash behind the frame. -->
			<iframe
				v-else
				:srcdoc="html"
				sandbox=""
				:title="t('components.email.templateHistoryPanel.frameTitle')"
				class="w-full h-full bg-white"
			/>
			<!-- palette-ok-end -->
		</div>

		<UiModalFooter>
			<UiButton variant="secondary" @click="open = false">
				{{ t('common.close') }}
			</UiButton>
			<UiButton
				v-if="canCompare"
				variant="secondary"
				:disabled="!version"
				@click="version && emit('compare')"
			>
				<template #iconLeft>
					<GitCompareIcon class="w-4 h-4" />
				</template>
				{{ t('components.email.templateHistoryPanel.compare') }}
			</UiButton>
			<UiButton :loading="restoring" :disabled="!version" @click="version && emit('restore')">
				<template #iconLeft>
					<RotateLeftIcon class="w-4 h-4" />
				</template>
				{{ t('components.email.templateHistoryPanel.restore') }}
			</UiButton>
		</UiModalFooter>
	</UiModal>
</template>
