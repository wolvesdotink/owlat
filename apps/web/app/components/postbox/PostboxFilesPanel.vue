<script setup lang="ts">
/**
 * Files — browse everything ever attached to this mailbox's mail.
 *
 * Reads the `mailAttachments` index, so this is a first-class list rather than
 * a scan: "where is that contract PDF?" used to mean remembering who sent it,
 * finding the thread, scrolling to the message and finding the chip. Facets
 * narrow by filename, type, sender and recency; a previewable file opens in the
 * same Quick Look overlay the thread reader uses, and everything else downloads.
 *
 * Extraction is deliberately identical to the reader's: fetch the parent
 * message's raw .eml and pull the recorded MIME part. The index stores metadata
 * only — no attachment content is duplicated anywhere.
 */

import type { Id } from '@owlat/api/dataModel';
import { extractAttachmentAt } from '@owlat/shared/mailMime';
import { formatCompactFileSize, formatCompactRelativeTime } from '~/utils/formatters';
import {
	POSTBOX_FILE_DATE_RANGES,
	POSTBOX_FILE_KINDS,
	previewSliceFor,
	type PostboxFileKind,
} from '~/utils/postboxFileFacets';

const props = defineProps<{ mailboxId: Id<'mailboxes'> }>();

const { t } = useI18n();
const { showToast } = useToast();
const { showOperationError } = useOperationErrorToast();

const mailboxIdRef = computed(() => props.mailboxId);
const {
	files,
	isLoading,
	isLoadingMore,
	canLoadMore,
	loadMore,
	senderFacets,
	query,
	fromAddress,
	kinds,
	dateRange,
	isFiltered,
	toggleKind,
	clearFacets,
} = usePostboxFiles(mailboxIdRef);

// The backfill over pre-index mail: a mailbox that never ran it would show
// "no files" for years of attachments, which reads as a bug rather than as an
// index that has not been built yet.
const {
	status: backfill,
	start: startBackfill,
	isStarting,
} = usePostboxFileIndexBackfill(mailboxIdRef);

/** Icon per coarse kind — the facet vocabulary, drawn. */
const KIND_ICONS: Record<PostboxFileKind, string> = {
	pdf: 'lucide:file-text',
	image: 'lucide:image',
	document: 'lucide:file',
	archive: 'lucide:file-archive',
	other: 'lucide:paperclip',
};

type FileRow = (typeof files.value)[number];

async function extractBlob(file: FileRow): Promise<Blob | null> {
	const bin = await loadRawEml(file.messageId);
	if (!bin) return null;
	const extracted = extractAttachmentAt(bin, file.partIndex, file.filename);
	if (!extracted) return null;
	return new Blob([extracted.bytes as BlobPart], {
		type: extracted.contentType || file.contentType,
	});
}

const downloading = ref<string | null>(null);

async function download(file: FileRow) {
	downloading.value = file._id;
	try {
		const blob = await extractBlob(file);
		if (!blob) {
			showToast(t('components.postbox.postboxFilesPanel.downloadFailed'), 'error');
			return;
		}
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = file.filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 30000);
	} catch (err) {
		showOperationError(err, 'components.postbox.postboxFilesPanel.downloadFailed');
	} finally {
		downloading.value = null;
	}
}

const lightbox = ref<{ attachments: FileRow[]; index: number } | null>(null);

function open(file: FileRow) {
	const slice = previewSliceFor(files.value, file);
	// A non-previewable file has no overlay to open, so the row's primary action
	// is its download rather than a dead click.
	if (!slice) return void download(file);
	lightbox.value = slice;
}

function loadLightboxPart(att: { filename: string; partIndex?: string }): Promise<Blob | null> {
	const match = lightbox.value?.attachments.find(
		(f) => f.partIndex === att.partIndex && f.filename === att.filename
	);
	return match ? extractBlob(match) : Promise.resolve(null);
}

function downloadLightbox(att: { filename: string; partIndex?: string }) {
	const match = lightbox.value?.attachments.find(
		(f) => f.partIndex === att.partIndex && f.filename === att.filename
	);
	if (match) void download(match);
}
</script>

<template>
	<section>
		<header class="mb-4">
			<h1 class="text-xl font-semibold">{{ t('components.postbox.postboxFilesPanel.heading') }}</h1>
			<p class="text-sm text-text-secondary mt-1">
				{{ t('components.postbox.postboxFilesPanel.intro') }}
			</p>
		</header>

		<!-- The index over pre-existing mail is built on demand; until it has run
		     once, an empty list would be a lie about the mailbox's contents. -->
		<div
			v-if="!backfill || backfill.status === 'cancelled' || backfill.status === 'failed'"
			class="card p-4 mb-4 flex items-center justify-between gap-4"
		>
			<p class="text-sm text-text-secondary">
				{{ t('components.postbox.postboxFilesPanel.backfillPrompt') }}
			</p>
			<UiButton type="button" :disabled="isStarting" @click="startBackfill">
				{{ t('components.postbox.postboxFilesPanel.backfillStart') }}
			</UiButton>
		</div>
		<div
			v-else-if="backfill.status === 'running'"
			class="card p-4 mb-4 flex items-center gap-3 text-sm text-text-secondary"
		>
			<Icon name="lucide:loader-2" class="w-4 h-4 animate-spin motion-reduce:animate-none flex-shrink-0" />
			{{
				t('components.postbox.postboxFilesPanel.backfillRunning', {
					scanned: backfill.scannedCount,
					indexed: backfill.indexedCount,
				})
			}}
		</div>

		<!-- Facets: filename, type, sender, recency. -->
		<div class="card p-4 mb-4 space-y-3">
			<label class="block">
				<span class="sr-only">{{ t('components.postbox.postboxFilesPanel.searchLabel') }}</span>
				<input
					v-model="query"
					type="search"
					class="input w-full"
					:placeholder="t('components.postbox.postboxFilesPanel.searchPlaceholder')"
				/>
			</label>

			<div class="flex flex-wrap items-center gap-1.5">
				<button
					v-for="opt in POSTBOX_FILE_KINDS"
					:key="opt.value"
					type="button"
					class="px-2.5 py-1 rounded-full text-xs border"
					:class="
						kinds.includes(opt.value)
							? 'bg-brand/10 border-brand text-brand'
							: 'border-border-subtle text-text-secondary hover:bg-bg-surface'
					"
					:aria-pressed="kinds.includes(opt.value)"
					@click="toggleKind(opt.value)"
				>
					{{ t(opt.labelKey) }}
				</button>
			</div>

			<div class="flex flex-wrap items-center gap-3">
				<label class="flex items-center gap-1.5 text-xs text-text-secondary">
					{{ t('components.postbox.postboxFilesPanel.fromLabel') }}
					<select v-model="fromAddress" class="input input-sm">
						<option :value="null">
							{{ t('components.postbox.postboxFilesPanel.anySender') }}
						</option>
						<option v-for="s in senderFacets" :key="s.address" :value="s.address">
							{{ s.address }} ({{ s.count }})
						</option>
					</select>
				</label>
				<label class="flex items-center gap-1.5 text-xs text-text-secondary">
					{{ t('components.postbox.postboxFilesPanel.dateLabel') }}
					<select v-model="dateRange" class="input input-sm">
						<option v-for="opt in POSTBOX_FILE_DATE_RANGES" :key="opt.value" :value="opt.value">
							{{ t(opt.labelKey) }}
						</option>
					</select>
				</label>
				<button
					v-if="isFiltered"
					type="button"
					class="text-xs text-brand hover:underline"
					@click="clearFacets"
				>
					{{ t('components.postbox.postboxFilesPanel.clearFacets') }}
				</button>
			</div>
		</div>

		<div v-if="isLoading" class="p-8 flex justify-center">
			<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin motion-reduce:animate-none text-text-tertiary" />
		</div>
		<p v-else-if="files.length === 0" class="card p-8 text-center text-text-secondary">
			{{
				isFiltered
					? t('components.postbox.postboxFilesPanel.emptyFiltered')
					: t('components.postbox.postboxFilesPanel.empty')
			}}
		</p>
		<ul v-else class="card !p-0 divide-y divide-border-subtle">
			<li v-for="file in files" :key="file._id" class="flex items-center gap-3 px-4 py-2.5">
				<button
					type="button"
					class="flex-1 flex items-center gap-3 min-w-0 text-left"
					@click="open(file)"
				>
					<Icon :name="KIND_ICONS[file.kind]" class="w-5 h-5 flex-shrink-0 text-text-tertiary" />
					<span class="min-w-0">
						<span class="block truncate font-medium text-sm">{{ file.filename }}</span>
						<span class="block truncate text-xs text-text-tertiary">
							{{ file.fromName || file.fromAddress }} · {{ formatCompactFileSize(file.size) }} ·
							{{ formatCompactRelativeTime(file.receivedAt) }}
						</span>
					</span>
				</button>
				<NuxtLink
					:to="`/dashboard/postbox/${file.folderParam}/${file.messageId}`"
					class="text-xs text-text-tertiary hover:text-brand truncate max-w-[14rem] hidden sm:block"
					:title="file.subject"
				>
					{{ file.subject }}
				</NuxtLink>
				<button
					type="button"
					class="p-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface"
					:disabled="downloading === file._id"
					:aria-label="t('components.postbox.postboxFilesPanel.download', { name: file.filename })"
					@click="download(file)"
				>
					<Icon
						:name="downloading === file._id ? 'lucide:loader-2' : 'lucide:download'"
						class="w-4 h-4"
						:class="{ 'animate-spin motion-reduce:animate-none': downloading === file._id }"
					/>
				</button>
			</li>
		</ul>

		<div v-if="canLoadMore" class="mt-4 flex justify-center">
			<UiButton variant="ghost" type="button" :disabled="isLoadingMore" @click="loadMore">
				{{ t('components.postbox.postboxFilesPanel.loadMore') }}
			</UiButton>
		</div>

		<PostboxAttachmentLightbox
			v-if="lightbox"
			:attachments="lightbox.attachments"
			:initial-index="lightbox.index"
			:load-part="loadLightboxPart"
			@close="lightbox = null"
			@download="downloadLightbox"
		/>
	</section>
</template>
