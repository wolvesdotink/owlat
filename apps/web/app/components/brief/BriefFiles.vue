<script setup lang="ts">
/**
 * "Files": every file that went through the thread, in or out, as chips with
 * who sent it and when (plan §4.1). A chip is a button when the host can do
 * something with it: Answer mode attaches it to the reply, the reader opens
 * the message it came with.
 */
import { inject } from 'vue';
import type { FileView } from '../../../../api/convex/mail/interpret/briefShape';
import { briefShortDate, BRIEF_CONTEXT } from '~/utils/threadBriefContext';
import BriefSection from './BriefSection.vue';

const props = defineProps<{
	files: readonly FileView[];
	/** What a click does: `attach` (Answer mode) or `open` (the reader). */
	action?: 'attach' | 'open';
}>();

const emit = defineEmits<{ select: [file: FileView] }>();

const { t, locale } = useI18n();
const context = inject(BRIEF_CONTEXT, null);

function who(file: FileView): string {
	if (file.direction === 'out') return t('components.brief.files.you');
	const source = context?.sourceOf(file.messageId);
	return source?.name || source?.email || '';
}
function label(file: FileView): string {
	return [who(file), briefShortDate(file.at, locale.value)].filter(Boolean).join(', ');
}
const actionLabelKey = computed(() =>
	props.action === 'attach' ? 'components.brief.files.attach' : 'components.brief.files.open'
);
</script>

<template>
	<BriefSection
		v-if="files.length > 0"
		:title="t('components.brief.files.title')"
		heading-id="brief-files"
	>
		<ul class="flex flex-wrap gap-2" data-testid="brief-files">
			<li v-for="file in files" :key="`${file.messageId}:${file.attachmentId}`">
				<component
					:is="action ? 'button' : 'span'"
					:type="action ? 'button' : undefined"
					class="inline-flex items-center gap-1 rounded-full bg-bg-elevated px-2.5 py-0.5 text-xs text-text-secondary shadow-(--shadow-1)"
					:class="action ? 'hover:text-text-primary' : ''"
					:aria-label="action ? t(actionLabelKey, { name: file.filename }) : undefined"
					@click="action && emit('select', file)"
				>
					<b class="font-medium text-text-primary">{{ file.filename }}</b>
					<span>· {{ label(file) }}</span>
				</component>
			</li>
		</ul>
	</BriefSection>
</template>
