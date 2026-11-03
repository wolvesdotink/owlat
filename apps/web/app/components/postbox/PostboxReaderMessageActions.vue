<script setup lang="ts">
/**
 * The action row under one expanded message in the reader: Star, Reply,
 * Reply all, Forward and the ⋯ overflow (the sender's text zoom, copy link,
 * share in chat, share as image, report spam, block, filter, print, download
 * the original).
 * Split out of PostboxReaderMessage so Answer mode can render the same card
 * without it (you are already replying there). Every verb on the mail is
 * emitted back to the reader; the zoom is this device's view of it and is set
 * here.
 */
import { usePostboxOriginalEml } from '~/composables/postbox/usePostboxOriginalEml';
import { useSenderZoom } from '~/composables/useSenderZoom';
import { postboxSenderKey } from '~/utils/postboxImageAllowlist';
import { senderZoomAtLimit, type SenderZoomAction } from '~/utils/senderZoom';
import {
	ChatShareIcon,
	CircleSlashIcon,
	DownloadIcon,
	FilterIcon,
	ForwardIcon,
	ImageIcon,
	LinkIcon,
	MinusIcon,
	PlusIcon,
	PrinterIcon,
	ReplyAllIcon,
	ReplyIcon,
	ShieldWarningIcon,
	StarIcon,
	ZoomInIcon,
	type IconComponent,
} from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const props = defineProps<{
	messageId: string;
	starred: boolean;
	/** Whether Reply-all would add anyone beyond a plain Reply. */
	showReplyAll: boolean;
	/** The From header; the zoom row shows only when it holds an address. */
	fromAddress?: string;
	/** The body is the reader's to show as text (not sealed or signed mail shown by its badge). */
	canShareImage?: boolean;
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
	(e: 'share-image'): void;
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

const { zoomOf, applyZoom } = useSenderZoom();
const hasSender = computed(() => postboxSenderKey(props.fromAddress) !== null);
const zoom = computed(() => zoomOf(props.fromAddress));
const zoomControls: ReadonlyArray<{
	action: SenderZoomAction;
	icon: IconComponent | null;
	key: string;
}> = [
	{ action: 'zoomOut', icon: MinusIcon, key: 'zoomOut' },
	{ action: 'zoomReset', icon: null, key: 'zoomReset' },
	{ action: 'zoomIn', icon: PlusIcon, key: 'zoomIn' },
];

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
				<!-- Stays open while stepping, so the size can be read as it changes. -->
				<div
					v-if="hasSender"
					role="group"
					:aria-label="t('components.postbox.postboxThreadReader.zoomLabel')"
					class="flex items-center gap-1 px-3 py-1 text-sm border-b border-border-subtle mb-1"
				>
					<ZoomInIcon class="w-4 h-4 text-text-tertiary" />
					<span class="flex-1 ml-1">{{
						t('components.postbox.postboxThreadReader.zoomLabel')
					}}</span>
					<button
						v-for="control in zoomControls"
						:key="control.action"
						type="button"
						role="menuitem"
						class="h-7 rounded hover:bg-bg-surface disabled:hover:bg-transparent inline-flex items-center justify-center"
						:class="control.icon ? 'w-7 disabled:opacity-40' : 'min-w-12 px-1 tabular-nums'"
						:aria-label="
							t(`components.postbox.postboxThreadReader.${control.key}`, { percent: zoom })
						"
						:disabled="senderZoomAtLimit(zoom, control.action)"
						@click="applyZoom(fromAddress, control.action)"
					>
						<component v-if="control.icon" :is="control.icon" class="w-4 h-4" />
						<template v-else>{{
							t('components.postbox.postboxThreadReader.zoomPercent', { percent: zoom })
						}}</template>
					</button>
				</div>
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
					<ChatShareIcon class="w-4 h-4 text-text-tertiary" />
					{{ t('shared.conversationLink.shareInChat') }}
				</button>
				<button
					v-if="canShareImage"
					type="button"
					role="menuitem"
					:class="MENU_ITEM_CLASS"
					@click="
						emit('share-image');
						close();
					"
				>
					<ImageIcon class="w-4 h-4 text-text-tertiary" />
					{{ t('components.postbox.postboxShareImage.menuItem') }}
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
