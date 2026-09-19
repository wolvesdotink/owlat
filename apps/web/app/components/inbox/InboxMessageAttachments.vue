<script setup lang="ts">
import { formatCompactFileSize } from '~/utils/formatters';

/**
 * The attachment rows under one team-inbox message: name, size, type and a
 * download.
 *
 * Presentational only. Downloading means fetching the message's raw `.eml` and
 * extracting the part client-side, and that — with its spinner, its toast and
 * its object-URL lifetime — belongs to the page, which owns the reader state.
 *
 * Three states, because an attachment listed here is not always fetchable:
 *   · normal — the row downloads;
 *   · BLOCKED — malware was found in this message, so there is no download
 *     control at all, not a disabled one;
 *   · EXPIRED — the retention sweep released the message's files (or it
 *     arrived before the route carried them). The names and sizes are still
 *     known from the stored metadata, so the row says what was there and why
 *     it is not, rather than disappearing. The control stays, disabled, so the
 *     reason sits next to the thing it explains.
 *
 * A sibling of PostboxMessageAttachments rather than a reuse of it: that one is
 * Postbox-namespaced down to its i18n keys, and this surface has no Quick Look.
 */
export type InboxAttachmentMeta = {
	filename: string;
	contentType: string;
	size: number;
	partIndex?: string;
};

const props = defineProps<{
	attachments: InboxAttachmentMeta[];
	/** This message's id — the first half of `downloadingKey`. */
	messageId: string;
	/** `${messageId}:${part}` of the attachment being fetched right now, if any. */
	downloadingKey?: string | null;
	/** Aggregate malware verdict for the message these parts came from. */
	virusVerdict?: 'clean' | 'infected' | 'skipped';
	/** The message's stored files are gone — swept, or never carried. */
	isExpired?: boolean;
}>();

const emit = defineEmits<{
	(e: 'download', att: InboxAttachmentMeta): void;
}>();

const { t } = useI18n();

const isBlocked = computed(() => props.virusVerdict === 'infected');

function isDownloading(att: InboxAttachmentMeta): boolean {
	return props.downloadingKey === `${props.messageId}:${att.partIndex ?? att.filename}`;
}
</script>

<template>
	<section v-if="attachments.length > 0" class="mt-4" data-testid="inbox-message-attachments">
		<p class="text-xs text-text-tertiary mb-2 font-medium uppercase tracking-wider">
			{{ t('components.inbox.inboxMessageAttachments.heading') }}
		</p>

		<p v-if="isBlocked" class="mb-2 text-xs text-warning" data-testid="inbox-attachments-blocked">
			{{ t('components.inbox.inboxMessageAttachments.blocked') }}
		</p>
		<p
			v-else-if="isExpired"
			class="mb-2 text-xs text-text-tertiary"
			data-testid="inbox-attachments-expired"
		>
			{{ t('components.inbox.inboxMessageAttachments.expired') }}
		</p>

		<ul class="grid grid-cols-1 sm:grid-cols-2 gap-2">
			<li
				v-for="(att, i) in attachments"
				:key="i"
				class="flex items-center gap-2 px-3 py-2 rounded border border-border-subtle"
				data-testid="inbox-attachment-row"
			>
				<Icon name="lucide:paperclip" class="w-4 h-4 text-text-tertiary flex-shrink-0" />
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm">{{ att.filename }}</p>
					<p class="text-xs text-text-tertiary">
						{{ formatCompactFileSize(att.size) }} · {{ att.contentType }}
					</p>
				</div>
				<!-- Blocked mail offers no download control at all; an expired one
				     keeps it, disabled, beside the line that says why. -->
				<button
					v-if="!isBlocked"
					type="button"
					class="p-1 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary disabled:opacity-50"
					:title="
						t('components.inbox.inboxMessageAttachments.download', { filename: att.filename })
					"
					:aria-label="
						t('components.inbox.inboxMessageAttachments.download', { filename: att.filename })
					"
					:disabled="isDownloading(att) || isExpired === true"
					data-testid="inbox-attachment-download"
					@click="emit('download', att)"
				>
					<Icon
						:name="isDownloading(att) ? 'lucide:loader-2' : 'lucide:download'"
						class="w-4 h-4"
						:class="{ 'animate-spin motion-reduce:animate-none': isDownloading(att) }"
					/>
				</button>
			</li>
		</ul>
	</section>
</template>
