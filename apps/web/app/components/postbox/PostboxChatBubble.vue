<script setup lang="ts">
/**
 * One message of the chat layout (usePostboxThreadChat): what its sender wrote
 * this time, without the quoted history, signature or legal footer
 * (`segmentMessage`), with its attachments as chips and the full message one
 * click away.
 *
 * The bubble shows plain text: no HTML, remote images or tracking pixels from
 * the sender reach the page, so it needs none of the card's sanitising and
 * image-privacy machinery. Signed or encrypted mail never shows as a bubble,
 * because only the card's security badge says what the signature covers: the
 * host routes it to the card, and a clearsigned body, recognised only once its
 * text has arrived, is handed back with `secure`.
 */
import { segmentMessage } from '@owlat/shared/mailSegments';
import { classifySecureMessage } from '@owlat/shared/secureMessage';
import {
	formatCompactFileSize,
	formatCompactRelativeTime,
	formatDateTime,
} from '~/utils/formatters';
import { isPreviewableFile } from '~/utils/postboxFileFacets';
import type { AttachmentMeta } from '~/utils/attachmentMeta';
import type { PostboxReaderMessage } from '~/composables/postbox/postboxReaderMessage';
import { usePostboxBodySource } from '~/composables/postbox/usePostboxBodySource';
import { PaperclipIcon } from '@coolicons/vue';

const props = defineProps<{
	message: PostboxReaderMessage;
	/** The viewer wrote it: the bubble sits on the right. */
	own: boolean;
}>();

const emit = defineEmits<{
	'show-full': [];
	/** The body turned out to be signed or encrypted: show the card instead. */
	secure: [];
	preview: [att: AttachmentMeta, all: AttachmentMeta[]];
	download: [att: AttachmentMeta];
}>();

const { t } = useI18n();

const body = usePostboxBodySource(() => props.message);

const withheld = computed(
	() =>
		!body.waiting.value &&
		classifySecureMessage({
			attachments: [...props.message.attachments],
			textBody: body.effectiveText.value,
		}) !== 'none'
);
watch(withheld, (isSecure) => isSecure && emit('secure'), { immediate: true });

/** The sender's own words this time; null while loading, '' when there are none. */
const fresh = computed<string | null>(() => {
	if (withheld.value) return '';
	if (body.waiting.value) return null;
	const seg = segmentMessage({
		html: body.effectiveHtml.value ?? null,
		text: body.effectiveText.value,
		subject: props.message.subject,
	});
	return seg.segments
		.filter((s) => s.kind === 'fresh')
		.map((s) => seg.canonicalText.slice(s.start, s.end))
		.join('\n\n');
});

const sender = computed(() =>
	props.own
		? t('components.postbox.threadChat.you')
		: props.message.fromName || props.message.fromAddress
);

const attachments = computed(() => props.message.attachments as AttachmentMeta[]);

function openAttachment(att: AttachmentMeta) {
	if (isPreviewableFile(att.contentType)) emit('preview', att, attachments.value);
	else emit('download', att);
}
</script>

<template>
	<div
		class="flex items-end gap-2"
		:class="own ? 'flex-row-reverse' : ''"
		:data-message-id="message._id"
		:data-own="own ? '' : undefined"
		data-testid="chat-bubble"
	>
		<UiAvatar
			:name="message.fromName"
			:email="message.fromAddress"
			deterministic-color
			size="md"
			class="flex-shrink-0 mb-6"
			aria-hidden="true"
		/>
		<div class="flex min-w-0 max-w-[80%] flex-col" :class="own ? 'items-end' : 'items-start'">
			<p class="mb-1 px-1 text-xs text-text-tertiary">
				<span class="font-medium text-text-secondary">{{ sender }}</span>
				<span class="mx-1">·</span>
				<span class="tabular-nums" :title="formatDateTime(message.receivedAt)">{{
					formatCompactRelativeTime(message.receivedAt)
				}}</span>
			</p>
			<div
				class="min-w-0 max-w-full rounded-2xl px-3.5 py-2 text-sm text-text-primary"
				:class="
					own
						? 'rounded-br-md bg-brand-subtle'
						: 'rounded-bl-md border border-border-subtle bg-bg-elevated'
				"
			>
				<div
					v-if="withheld || fresh === null"
					class="h-4 w-40 animate-pulse motion-reduce:animate-none rounded bg-bg-surface"
				/>
				<p v-else-if="fresh" class="whitespace-pre-wrap break-words" data-testid="chat-bubble-text">
					{{ fresh }}
				</p>
				<p v-else class="italic text-text-secondary">
					{{ t('components.postbox.threadChat.noNewText') }}
				</p>
				<ul
					v-if="attachments.length > 0 && !withheld"
					class="mt-2 flex flex-wrap gap-1.5"
					:aria-label="t('components.postbox.threadChat.attachments')"
				>
					<li v-for="att in attachments" :key="att.partIndex ?? att.filename">
						<!-- native-title: the full name of a filename the chip truncates -->
						<button
							type="button"
							class="inline-flex max-w-56 items-center gap-1.5 rounded-full border border-border-subtle bg-bg-base px-2.5 py-1 text-xs text-text-secondary outline-none hover:text-text-primary focus-visible:ring-1 focus-visible:ring-brand/40"
							:title="att.filename"
							@click="openAttachment(att)"
						>
							<PaperclipIcon class="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
							<span class="truncate">{{ att.filename }}</span>
							<span class="flex-shrink-0 tabular-nums text-text-tertiary">{{
								formatCompactFileSize(att.size)
							}}</span>
						</button>
					</li>
				</ul>
			</div>
			<button
				type="button"
				class="mt-1 rounded px-1 text-xs text-text-tertiary outline-none hover:text-text-primary focus-visible:ring-1 focus-visible:ring-brand/40"
				data-testid="chat-bubble-show-full"
				@click="emit('show-full')"
			>
				{{ t('components.postbox.threadChat.showFull') }}
			</button>
		</div>
	</div>
</template>
