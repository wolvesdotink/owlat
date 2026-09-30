<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { UploadChip } from '~/composables/postbox/postboxAttachmentUploads';
import type {
	TeamAttachSuggestion,
	TeamReplyAttachmentView,
} from '~/composables/useTeamReplyAttachments';
import { formatCompactFileSize } from '~/utils/formatters';

/**
 * The files on a Team inbox reply, under the editor in Answer mode: what is
 * attached (a copy still running shows as "Copying…", a failed copy says so
 * and can only be removed), uploads in flight, the file the agent matched to
 * what the customer asked for (`AttachSuggestion`), and an Attach menu:
 * upload a file, or pick one of the contact's files, this conversation's
 * first.
 *
 * Presentation only; the column owns `useTeamReplyAttachments` and runs what
 * this emits.
 */
const props = defineProps<{
	threadId: Id<'conversationThreads'>;
	contactId?: Id<'contacts'> | null;
	/** Who the files are for, for "Other files for Ana". */
	contactName?: string;
	attachments: readonly TeamReplyAttachmentView[];
	uploads: readonly UploadChip[];
	suggestion: TeamAttachSuggestion | null;
	busy?: boolean;
}>();

const emit = defineEmits<{
	(e: 'upload', files: File[]): void;
	(e: 'attach-existing', source: 'semanticFile', id: string): void;
	(e: 'remove', index: number): void;
	(e: 'cancel-upload', id: string): void;
	(e: 'retry-upload', id: string): void;
}>();

const { t } = useI18n();

// The contact's files, read only once the menu is opened.
const menuOpen = ref(false);
const { data: contactFiles } = useConvexQuery(api.semanticFiles.listByContact, () =>
	menuOpen.value && props.contactId ? { contactId: props.contactId, limit: 20 } : 'skip'
);
const attachedSources = computed(
	() => new Set(props.attachments.map((a) => a.sourceId).filter(Boolean))
);
const pickable = computed(() =>
	(contactFiles.value ?? []).filter((file) => !attachedSources.value.has(file._id))
);
const fromThread = computed(() => pickable.value.filter((f) => f.threadId === props.threadId));
const fromContact = computed(() => pickable.value.filter((f) => f.threadId !== props.threadId));

const fileInput = ref<HTMLInputElement | null>(null);
function chooseUpload() {
	menuOpen.value = false;
	fileInput.value?.click();
}
function onFilesChosen(event: Event) {
	const input = event.target as HTMLInputElement;
	const files = Array.from(input.files ?? []);
	input.value = '';
	if (files.length > 0) emit('upload', files);
}
function pick(fileId: string) {
	menuOpen.value = false;
	emit('attach-existing', 'semanticFile', fileId);
}

function statusLine(attachment: TeamReplyAttachmentView): string {
	if (attachment.status === 'copying') return t('components.answer.team.attachments.copying');
	if (attachment.status === 'failed') {
		return attachment.copyError
			? t('components.answer.team.attachments.failedWithReason', {
					reason: attachment.copyError,
				})
			: t('components.answer.team.attachments.failed');
	}
	return formatCompactFileSize(attachment.size);
}

const menuItem =
	'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-bg-surface disabled:opacity-50';
</script>

<template>
	<div class="space-y-2" data-testid="answer-team-attachments">
		<InboxAttachSuggestion
			v-if="suggestion && suggestion.candidates.length > 0"
			:suggestions="suggestion"
			@attach="(candidate) => emit('attach-existing', 'semanticFile', candidate.fileId)"
		/>

		<ul v-if="attachments.length > 0 || uploads.length > 0" class="flex flex-wrap gap-1.5">
			<li
				v-for="(attachment, index) in attachments"
				:key="attachment.id"
				class="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
				:class="
					attachment.status === 'failed'
						? 'border-error/40 bg-error-subtle text-error'
						: 'border-border-subtle bg-bg-surface text-text-secondary'
				"
				:data-status="attachment.status"
				data-testid="answer-team-attachment"
			>
				<Icon
					:name="attachment.status === 'copying' ? 'lucide:loader-2' : 'lucide:paperclip'"
					class="size-3.5 shrink-0"
					:class="{ 'animate-spin motion-reduce:animate-none': attachment.status === 'copying' }"
					aria-hidden="true"
				/>
				<span class="truncate font-medium text-text-primary">{{ attachment.filename }}</span>
				<span class="shrink-0 text-text-tertiary">{{ statusLine(attachment) }}</span>
				<button
					type="button"
					class="-mr-1 rounded-full p-0.5 hover:bg-bg-elevated disabled:opacity-50"
					:disabled="busy"
					:aria-label="
						t('components.answer.team.attachments.remove', { file: attachment.filename })
					"
					data-testid="answer-team-attachment-remove"
					@click="emit('remove', index)"
				>
					<Icon name="lucide:x" class="size-3" aria-hidden="true" />
				</button>
			</li>
			<li
				v-for="upload in uploads"
				:key="upload.id"
				class="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-subtle bg-bg-surface px-2.5 py-1 text-xs text-text-secondary"
				:data-status="upload.status"
				data-testid="answer-team-upload"
			>
				<Icon
					:name="upload.status === 'failed' ? 'lucide:alert-triangle' : 'lucide:loader-2'"
					class="size-3.5 shrink-0"
					:class="{
						'animate-spin motion-reduce:animate-none': upload.status === 'uploading',
						'text-error': upload.status === 'failed',
					}"
					aria-hidden="true"
				/>
				<span class="truncate">{{ upload.filename }}</span>
				<span v-if="upload.status === 'uploading' && !upload.indeterminate" class="tabular-nums">
					{{ Math.round(upload.progress * 100) }}%
				</span>
				<button
					v-if="upload.status === 'failed'"
					type="button"
					class="rounded px-1 text-brand hover:underline"
					@click="emit('retry-upload', upload.id)"
				>
					{{ t('components.answer.team.attachments.retry') }}
				</button>
				<button
					type="button"
					class="-mr-1 rounded-full p-0.5 hover:bg-bg-elevated"
					:aria-label="
						t('components.answer.team.attachments.cancelUpload', { file: upload.filename })
					"
					@click="emit('cancel-upload', upload.id)"
				>
					<Icon name="lucide:x" class="size-3" aria-hidden="true" />
				</button>
			</li>
		</ul>

		<div class="relative">
			<UiButton
				variant="ghost"
				size="sm"
				:disabled="busy"
				aria-haspopup="menu"
				:aria-expanded="menuOpen"
				data-testid="answer-team-attach"
				@click="menuOpen = !menuOpen"
			>
				<Icon name="lucide:paperclip" class="size-3.5" aria-hidden="true" />
				{{ t('components.answer.team.attachments.attach') }}
			</UiButton>
			<div
				v-if="menuOpen"
				role="menu"
				class="absolute bottom-full left-0 z-20 mb-1 max-h-72 w-72 overflow-y-auto rounded border border-border-subtle bg-bg-elevated py-1 shadow-lg"
				@keydown.esc.prevent.stop="menuOpen = false"
			>
				<button
					type="button"
					role="menuitem"
					:class="menuItem"
					data-testid="answer-team-upload-choose"
					@click="chooseUpload"
				>
					<Icon name="lucide:upload" class="size-4 text-text-tertiary" aria-hidden="true" />
					{{ t('components.answer.team.attachments.upload') }}
				</button>
				<template v-if="contactId">
					<template
						v-for="group in [
							{
								key: 'thread',
								files: fromThread,
								label: t('components.answer.team.attachments.fromThread'),
							},
							{
								key: 'contact',
								files: fromContact,
								label: t('components.answer.team.attachments.fromContact', {
									name: contactName || '',
								}),
							},
						]"
						:key="group.key"
					>
						<template v-if="group.files.length > 0">
							<p
								class="px-3 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-text-tertiary"
							>
								{{ group.label }}
							</p>
							<button
								v-for="file in group.files"
								:key="file._id"
								type="button"
								role="menuitem"
								:class="menuItem"
								data-testid="answer-team-pick-file"
								@click="pick(file._id)"
							>
								<Icon
									name="lucide:file"
									class="size-4 shrink-0 text-text-tertiary"
									aria-hidden="true"
								/>
								<span class="flex-1 truncate">{{ file.title || file.filename }}</span>
								<span class="shrink-0 text-2xs text-text-tertiary">{{
									formatCompactFileSize(file.fileSize)
								}}</span>
							</button>
						</template>
					</template>
				</template>
			</div>
			<input
				ref="fileInput"
				type="file"
				multiple
				class="hidden"
				data-testid="answer-team-file-input"
				@change="onFilesChosen"
			/>
		</div>
	</div>
</template>
