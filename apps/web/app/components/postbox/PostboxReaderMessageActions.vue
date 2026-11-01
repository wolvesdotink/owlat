<script setup lang="ts">
/**
 * The action row under one expanded message in the reader: Star, Reply,
 * Reply all, Forward and the ⋯ overflow (copy link, share in chat, report
 * spam, block, filter, print, download the original). Split out of PostboxReaderMessage so Answer mode can
 * render the same card without it (you are already replying there).
 * Presentational; every verb is emitted back to the reader.
 */
import { usePostboxOriginalEml } from '~/composables/postbox/usePostboxOriginalEml';
import {
	CircleSlashIcon,
	DownloadIcon,
	FilterIcon,
	ForwardIcon,
	LinkIcon,
	PrinterIcon,
	ReplyAllIcon,
	ReplyIcon,
	ShareIcon,
	ShieldWarningIcon,
	StarIcon,
} from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

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
	(e: 'copy-link'): void;
	(e: 'share-in-chat'): void;
}>();

const { t } = useI18n();
const { isEnabled: isFeatureEnabled } = useFeatureFlag();

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
		<UiTooltip :text="starLabel">
			<UiButton
				variant="ghost"
				type="button"
				:class="starred ? 'text-warning' : 'text-text-tertiary'"
				:aria-label="starLabel"
				:aria-pressed="starred"
				@click="emit('toggle-star')"
			>
				<StarIcon class="w-4 h-4" :class="{ 'fill-current': starred }" />
			</UiButton>
		</UiTooltip>
		<UiButton variant="ghost" type="button" @click="emit('reply')">
			<ReplyIcon class="w-4 h-4 mr-1.5" />
			{{ t('components.postbox.postboxThreadReader.reply') }}
		</UiButton>
		<UiButton
			v-if="showReplyAll"
			variant="ghost"
			type="button"
			class="pbx-reader-secondary-action"
			@click="emit('reply-all')"
		>
			<ReplyAllIcon class="w-4 h-4 mr-1.5" />
			{{ t('components.postbox.postboxThreadReader.replyAll') }}
		</UiButton>
		<UiButton
			variant="ghost"
			type="button"
			class="pbx-reader-secondary-action"
			@click="emit('forward')"
		>
			<ForwardIcon class="w-4 h-4 mr-1.5" />
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
						emit('copy-link');
						close();
					"
				>
					<LinkIcon class="w-4 h-4 text-text-tertiary" />
					{{ t('shared.conversationLink.copyLink') }}
				</button>
				<button
					v-if="isFeatureEnabled('chat')"
					type="button"
					role="menuitem"
					:class="MENU_ITEM_CLASS"
					@click="
						emit('share-in-chat');
						close();
					"
				>
					<ShareIcon class="w-4 h-4 text-text-tertiary" />
					{{ t('shared.conversationLink.shareInChat') }}
				</button>
				<button
					type="button"
					role="menuitem"
					:class="MENU_ITEM_CLASS"
					@click="
						emit('report-spam');
						close();
					"
				>
					<ShieldWarningIcon class="w-4 h-4 text-text-tertiary" />
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
					<CircleSlashIcon class="w-4 h-4 text-text-tertiary" />
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
					<FilterIcon class="w-4 h-4 text-text-tertiary" />
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
					<PrinterIcon class="w-4 h-4 text-text-tertiary" />
					{{ t('components.postbox.postboxThreadReader.print') }}
				</button>
				<button
					type="button"
					role="menuitem"
					:class="MENU_ITEM_CLASS"
					:disabled="downloadingEml"
					@click="downloadOriginal(messageId)"
				>
					<component
						:is="downloadingEml ? SpinnerIcon : DownloadIcon"
						class="w-4 h-4 text-text-tertiary"
						:class="{ 'animate-spin motion-reduce:animate-none': downloadingEml }"
					/>
					{{ t('components.postbox.postboxMessageDetails.download') }}
				</button>
			</template>
		</PostboxOverflowMenu>
	</div>
</template>
