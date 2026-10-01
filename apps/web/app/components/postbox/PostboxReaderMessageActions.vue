<script setup lang="ts">
/**
 * The action row under one expanded message in the reader: Star, Reply,
 * Reply all, Forward and the ⋯ overflow (report spam, block, filter, print,
 * download the original). Split out of PostboxReaderMessage so Answer mode can
 * render the same card without it (plan §09: you are already replying).
 * Presentational; every verb is emitted back to the reader.
 */
import { usePostboxOriginalEml } from '~/composables/postbox/usePostboxOriginalEml';

const props = defineProps<{
	messageId: string;
	starred: boolean;
	/** Whether Reply-all would add anyone beyond a plain Reply. */
	showReplyAll: boolean;
}>();

const emit = defineEmits<{
	(e: 'toggle-star'): void;
	(e: 'reply'): void;
	(e: 'reply-all'): void;
	(e: 'forward'): void;
	(e: 'report-spam'): void;
	(e: 'block-sender'): void;
	(e: 'create-filter'): void;
	(e: 'print'): void;
}>();

const { t } = useI18n();

const starLabel = computed(() =>
	props.starred
		? t('components.postbox.postboxThreadReader.unstar')
		: t('components.postbox.postboxThreadReader.star')
);

// The ⋯ item and the details disclosure both hand back the original `.eml`; one
// implementation so they cannot disagree about it.
const { downloading: downloadingEml, downloadOriginal } = usePostboxOriginalEml();

const MENU_ITEM_CLASS =
	'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-bg-surface disabled:opacity-60';
</script>

<template>
	<!-- Progressive disclosure: star + reply stay visible; reply-all and
	     forward reveal on row hover in compact density (pointer) and are
	     pinned open everywhere hover never fires. The ⋯ holds what is left
	     once the duplicates are gone. -->
	<div class="mt-4 flex items-center gap-2">
		<UiButton
			variant="ghost"
			type="button"
			:class="starred ? 'text-warning' : 'text-text-tertiary'"
			:title="starLabel"
			:aria-label="starLabel"
			:aria-pressed="starred"
			@click="emit('toggle-star')"
		>
			<Icon name="lucide:star" class="w-4 h-4" :class="{ 'fill-current': starred }" />
		</UiButton>
		<UiButton variant="ghost" type="button" @click="emit('reply')">
			<Icon name="lucide:reply" class="w-4 h-4 mr-1.5" />
			{{ t('components.postbox.postboxThreadReader.reply') }}
		</UiButton>
		<UiButton
			v-if="showReplyAll"
			variant="ghost"
			type="button"
			class="pbx-reader-secondary-action"
			@click="emit('reply-all')"
		>
			<Icon name="lucide:reply-all" class="w-4 h-4 mr-1.5" />
			{{ t('components.postbox.postboxThreadReader.replyAll') }}
		</UiButton>
		<UiButton
			variant="ghost"
			type="button"
			class="pbx-reader-secondary-action"
			@click="emit('forward')"
		>
			<Icon name="lucide:forward" class="w-4 h-4 mr-1.5" />
			{{ t('components.postbox.postboxThreadReader.forward') }}
		</UiButton>
		<span class="flex-1" />
		<PostboxOverflowMenu :label="t('components.postbox.postboxThreadReader.moreActions')">
			<template #default="{ close }">
				<button
					type="button"
					role="menuitem"
					:class="MENU_ITEM_CLASS"
					@click="
						emit('report-spam');
						close();
					"
				>
					<Icon name="lucide:shield-alert" class="w-4 h-4 text-text-tertiary" />
					{{ t('components.postbox.postboxThreadReader.reportSpam') }}
				</button>
				<button
					type="button"
					role="menuitem"
					:class="MENU_ITEM_CLASS"
					@click="
						emit('block-sender');
						close();
					"
				>
					<Icon name="lucide:ban" class="w-4 h-4 text-text-tertiary" />
					{{ t('components.postbox.postboxThreadReader.blockSender') }}
				</button>
				<!-- "One more of these" is where a filter gets written, so the rule
				     builder opens from the message, pre-filled with it. -->
				<button
					type="button"
					role="menuitem"
					:class="MENU_ITEM_CLASS"
					@click="
						emit('create-filter');
						close();
					"
				>
					<Icon name="lucide:filter" class="w-4 h-4 text-text-tertiary" />
					{{ t('components.postbox.postboxThreadReader.createFilter') }}
				</button>
				<button
					type="button"
					role="menuitem"
					:class="MENU_ITEM_CLASS"
					@click="
						emit('print');
						close();
					"
				>
					<Icon name="lucide:printer" class="w-4 h-4 text-text-tertiary" />
					{{ t('components.postbox.postboxThreadReader.print') }}
				</button>
				<button
					type="button"
					role="menuitem"
					:class="MENU_ITEM_CLASS"
					:disabled="downloadingEml"
					@click="downloadOriginal(messageId)"
				>
					<Icon
						:name="downloadingEml ? 'lucide:loader-2' : 'lucide:download'"
						class="w-4 h-4 text-text-tertiary"
						:class="{ 'animate-spin motion-reduce:animate-none': downloadingEml }"
					/>
					{{ t('components.postbox.postboxMessageDetails.download') }}
				</button>
			</template>
		</PostboxOverflowMenu>
	</div>
</template>
