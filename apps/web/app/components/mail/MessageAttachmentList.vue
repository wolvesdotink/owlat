<script setup lang="ts">
import { useId } from 'vue';
import { formatCompactFileSize } from '~/utils/formatters';
import { isPreviewableFile } from '~/utils/postboxFileFacets';
import { attachmentTypeLabel, type AttachmentMeta } from '~/utils/attachmentMeta';

/**
 * The attachment rows under one received message: name, size, type, an
 * optional eye for the previewable ones, and a download.
 *
 * ONE list for both readers. Postbox and the team inbox render the same rows
 * from the same metadata and differ only in their copy, whether Quick Look
 * exists, and whether the bytes are still there — so the copy arrives as label
 * props and the rest as flags, rather than as a second component that drifts
 * away from this one the first time somebody fixes an accessibility detail in
 * only one of them.
 *
 * Presentational only. Both verbs are emitted, because extracting a MIME part
 * means fetching the message's raw `.eml`, and that — with its spinner, its
 * toast and its object-URL lifetime — belongs to the reader that owns the
 * state.
 *
 * The row shape is `~/utils/attachmentMeta`, not a type declared here: a
 * `utils/` parser and two composables need it too, and a data shape owned by an
 * SFC forces them to import a component to describe their own data.
 */

const props = defineProps<{
	attachments: AttachmentMeta[];
	/** This message's id — the first half of `downloadingKey`. */
	messageId: string;
	/** `${messageId}:${part}` of the attachment being fetched right now, if any. */
	downloadingKey?: string | null;
	/** Section heading above the rows; omitted renders no heading. */
	heading?: string;
	/**
	 * The line above the rows explaining a non-normal state, as whole
	 * SENTENCES. A list rather than a string because two of them can apply at
	 * once ("no longer stored" plus "the original was 1.2 MB"), and joining
	 * translated sentences in code would bake one language's spacing and order
	 * into every locale.
	 */
	notice?: string[] | null;
	/** `warning` for malware, muted otherwise. */
	noticeTone?: 'warning' | 'muted';
	/** Image/PDF parts get an eye that opens the reader's Quick Look. */
	isPreviewEnabled?: boolean;
	/** No download control at all — not a disabled one (confirmed malware). */
	isDownloadHidden?: boolean;
	/**
	 * The bytes are not fetchable, but the control STAYS and stays focusable:
	 * `aria-disabled`, not `disabled`. A `disabled` button leaves the tab order,
	 * so a screen-reader user moving through the message meets the rows and is
	 * never told why none of them can be fetched — the notice explaining it is
	 * a paragraph they may already have passed. Reachable + `aria-describedby`
	 * is what makes the reason arrive with the control.
	 */
	isDownloadDisabled?: boolean;
	/** `(filename) => label` for the download control's title + aria-label. */
	downloadLabel: (filename: string) => string;
	/** Same, for the preview control. Required when `isPreviewEnabled`. */
	previewLabel?: (filename: string) => string;
	/** `data-testid` on the section, so each reader keeps its own hook. */
	testId?: string;
	/** `data-testid` on the notice line. */
	noticeTestId?: string;
}>();

const emit = defineEmits<{
	(e: 'preview', att: AttachmentMeta, all: AttachmentMeta[]): void;
	(e: 'download', att: AttachmentMeta): void;
}>();

/** "82.1 KB · PDF" — one short line; the full MIME type sits in the title. */
function metaLine(att: AttachmentMeta): string {
	const size = formatCompactFileSize(att.size);
	const type = attachmentTypeLabel(att);
	return type ? `${size} · ${type}` : size;
}

function isDownloading(att: AttachmentMeta): boolean {
	return props.downloadingKey === `${props.messageId}:${att.partIndex ?? att.filename}`;
}

/**
 * A stable row key. `partIndex` addresses exactly one MIME leaf, so it is the
 * real identity; legacy rows that predate it fall back to position AND name,
 * because two attachments called `scan.pdf` with no part index would otherwise
 * collide and both spin when one is fetched.
 */
function rowKey(att: AttachmentMeta, index: number): string {
	return att.partIndex ?? `${index}:${att.filename}`;
}

/**
 * The notice's element id, so every download control can point at it with
 * `aria-describedby`. `useId` rather than a module counter: two messages in one
 * thread each render this list, and a duplicate id would describe the wrong
 * one.
 */
const noticeId = useId();

const hasNotice = computed(() => (props.notice?.length ?? 0) > 0);

/** The disabled state is advisory (see `isDownloadDisabled`), so the click is refused here. */
function onDownload(att: AttachmentMeta): void {
	if (props.isDownloadDisabled === true || isDownloading(att)) return;
	emit('download', att);
}
</script>

<template>
	<section v-if="attachments.length > 0" class="mt-3" :data-testid="testId">
		<p v-if="heading" class="text-xs text-text-tertiary mb-2 font-medium uppercase tracking-wider">
			{{ heading }}
		</p>

		<p
			v-if="hasNotice"
			:id="noticeId"
			class="mb-2 text-xs"
			:class="noticeTone === 'warning' ? 'text-warning' : 'text-text-tertiary'"
			:data-testid="noticeTestId"
		>
			<span v-for="(sentence, s) in notice" :key="s" class="mr-1 last:mr-0">{{ sentence }}</span>
		</p>

		<ul class="grid grid-cols-1 sm:grid-cols-2 gap-2">
			<li
				v-for="(att, i) in attachments"
				:key="rowKey(att, i)"
				class="flex items-center gap-2 px-3 py-2 rounded border border-border-subtle"
				:aria-busy="isDownloading(att) ? 'true' : undefined"
				data-testid="message-attachment-row"
			>
				<Icon name="lucide:paperclip" class="w-4 h-4 text-text-tertiary flex-shrink-0" />
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm">{{ att.filename }}</p>
					<p class="truncate text-xs text-text-tertiary" :title="att.contentType">
						{{ metaLine(att) }}
					</p>
				</div>
				<button
					v-if="isPreviewEnabled && previewLabel && isPreviewableFile(att.contentType)"
					type="button"
					class="p-1 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary"
					:title="previewLabel(att.filename)"
					:aria-label="previewLabel(att.filename)"
					data-testid="message-attachment-preview"
					@click="emit('preview', att, attachments)"
				>
					<Icon name="lucide:eye" class="w-4 h-4" />
				</button>
				<button
					v-if="!isDownloadHidden"
					type="button"
					class="p-1 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary disabled:opacity-50 aria-disabled:opacity-50"
					:title="downloadLabel(att.filename)"
					:aria-label="downloadLabel(att.filename)"
					:aria-describedby="hasNotice ? noticeId : undefined"
					:aria-disabled="isDownloadDisabled === true ? 'true' : undefined"
					:disabled="isDownloading(att)"
					data-testid="message-attachment-download"
					@click="onDownload(att)"
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
