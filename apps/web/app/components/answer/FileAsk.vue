<script setup lang="ts">
/**
 * The answer to a file question (plan §06): the file they asked for, from
 * wherever it is.
 *
 *  - drop it here, or choose it from disk: it is uploaded now and attached to
 *    the reply when the answers go out, and saved to the contact's Files
 *    unless "Don't keep a copy" is ticked (plan decision 5);
 *  - a candidate the AI found ("Close, but maybe not it: ... August");
 *  - "Pick from Files": any file in Files or this inbox's mail;
 *  - a file chip dragged over from "Files in this thread";
 *  - or one of the question's own options, such as "It isn't ready yet".
 *
 * The value is either a file reference or an option. The parent turns it into
 * the answer the server takes. With `multiple` (a Reply Queue question such as
 * "the invoices for our four bookings") the value is a list of files: each
 * pick adds one, and the drop zone stays open for the next.
 */
import type { Id } from '@owlat/api/dataModel';
import { MAX_FILES_PER_ANSWER } from '@owlat/shared/answerMode';
import type { AskQuestion } from '~/composables/useAnswerAskSession';
import { useAnswerFileUpload } from '~/composables/useAnswerFileUpload';
import { threadFileFromDrop, type ThreadFile } from '~/utils/answerThreadFiles';
import { isAcceptedAnswerUpload, pickAnswerFile } from '~/utils/answerFilePicker';
import { formatCompactFileSize } from '~/utils/formatters';
import AnswerFilePicker, { type PickedFile } from './AnswerFilePicker.vue';

export interface FileAnswerRef {
	source: 'upload' | 'semanticFile' | 'mailAttachment';
	id: string;
	filename: string;
}

/**
 * Whether an uploaded answer is kept in Files, as the server decides it
 * (lib/answerFileToFiles.ts): only for someone who may add to Files
 * (organization:manage) and only for a known contact.
 *  - `kept`: both hold; "Don't keep a copy" is offered.
 *  - `ifContact`: the caller may, but the page cannot tell whether the sender
 *    is a contact (a Postbox reply); offered, and the line says so.
 *  - `never`: nothing is kept; no toggle, and the line says "this reply only".
 */
export type FileCopyPolicy = 'kept' | 'ifContact' | 'never';

export type FileAskValue =
	| { kind: 'file'; file: FileAnswerRef; keepCopy: boolean }
	| { kind: 'files'; files: FileAnswerRef[]; keepCopy: boolean }
	| { kind: 'option'; value: string }
	| null;

const props = defineProps<{
	question: AskQuestion;
	/** The question's options in the reader's language (the chips' labels). */
	options: readonly string[];
	modelValue: FileAskValue;
	/** The inbox the reply goes out from, for "Pick from Files". */
	mailboxId?: Id<'mailboxes'>;
	/** Turn a thread file chip into a file reference (the page knows how). */
	resolveThreadFile?: (file: ThreadFile) => Promise<FileAnswerRef | null>;
	disabled?: boolean;
	/** Whether an upload is kept in Files; `kept` when omitted. */
	copyPolicy?: FileCopyPolicy;
	/** Take several files (the value is then `kind: 'files'`). */
	multiple?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: FileAskValue] }>();

const { t } = useI18n();
const { showToast } = useToast();
const { upload, uploading, progress } = useAnswerFileUpload();

const pickerOpen = ref(false);
const dragOver = ref(false);
const resolving = ref(false);
/** "Don't keep a copy": only an upload is ever kept, so only an upload asks. */
const dontKeep = ref(false);
const neverKept = computed(() => props.copyPolicy === 'never');
/** Nothing will be kept: by the person's choice or by the server's rule. */
const attachedOnly = computed(() => neverKept.value || dontKeep.value);

const candidates = computed(() => props.question.fileCandidates ?? []);
const candidateLabels = computed(
	() => new Set(candidates.value.flatMap((c) => [c.filename, c.title ?? '']))
);
/** Options that are not a candidate's name again (older rows list both). */
const optionChips = computed(() => props.options.filter((o) => !candidateLabels.value.has(o)));
/** The AI found nothing that fits: its candidates are near misses. */
const nearMisses = computed(() => optionChips.value.length > 0);

const picked = computed(() => (props.modelValue?.kind === 'file' ? props.modelValue.file : null));
/** Every file picked so far: the list in `multiple` mode, else the one file. */
const pickedFiles = computed((): FileAnswerRef[] => {
	if (props.modelValue?.kind === 'files') return props.modelValue.files;
	return picked.value ? [picked.value] : [];
});
const isFull = computed(() => props.multiple && pickedFiles.value.length >= MAX_FILES_PER_ANSWER);
const pickedOption = computed(() =>
	props.modelValue?.kind === 'option' ? props.modelValue.value : null
);
const isSameFile = (a: { source: string; id: string }, b: { source: string; id: string }) =>
	a.source === b.source && a.id === b.id;

function setFiles(files: FileAnswerRef[]) {
	emit(
		'update:modelValue',
		files.length > 0 ? { kind: 'files', files, keepCopy: !attachedOnly.value } : null
	);
}

function setFile(file: FileAnswerRef) {
	if (!props.multiple) {
		emit('update:modelValue', { kind: 'file', file, keepCopy: !attachedOnly.value });
		return;
	}
	if (isFull.value || pickedFiles.value.some((f) => isSameFile(f, file))) return;
	setFiles([...pickedFiles.value, file]);
}

function removeFile(file: FileAnswerRef) {
	setFiles(pickedFiles.value.filter((f) => !isSameFile(f, file)));
}

watch(dontKeep, (value) => {
	const current = props.modelValue;
	if (current?.kind === 'file' && current.file.source === 'upload') {
		emit('update:modelValue', { ...current, keepCopy: !value });
	} else if (current?.kind === 'files' && current.files.some((f) => f.source === 'upload')) {
		emit('update:modelValue', { ...current, keepCopy: !value });
	}
});

async function uploadFile(file: File) {
	// The picker filters by type; a drop or an "All files" pick does not.
	if (!isAcceptedAnswerUpload(file)) {
		showToast(t('components.answer.fileAsk.unsupported', { filename: file.name }), 'error');
		return;
	}
	const done = await upload(file);
	if (done) setFile({ source: 'upload', id: done.storageId, filename: done.filename });
}

/** The OS picker (on a phone it offers the camera too). Opened inside the tap. */
async function choose() {
	const file = await pickAnswerFile();
	if (file) await uploadFile(file);
}

// Over this zone the drop is the answer's, not the composer's: its own
// drop overlay stays off, and it never also attaches what lands here.
function onDragOver(event: DragEvent) {
	event.stopPropagation();
	if (props.disabled) return;
	event.preventDefault();
	dragOver.value = true;
}

async function onDrop(event: DragEvent) {
	event.preventDefault();
	event.stopPropagation();
	dragOver.value = false;
	if (props.disabled) return;
	const threadFile = threadFileFromDrop(event.dataTransfer);
	if (threadFile) {
		if (!props.resolveThreadFile) return;
		resolving.value = true;
		try {
			const ref = await props.resolveThreadFile(threadFile);
			if (ref) setFile(ref);
		} finally {
			resolving.value = false;
		}
		return;
	}
	const dropped = [...(event.dataTransfer?.files ?? [])];
	// One at a time: each upload's `setFile` reads the list the last one left.
	for (const file of props.multiple ? dropped : dropped.slice(0, 1)) await uploadFile(file);
}

function pickCandidate(candidate: (typeof candidates.value)[number]) {
	const ref = { source: candidate.source, id: candidate.id, filename: candidate.filename };
	if (props.multiple && isPickedCandidate(candidate)) removeFile(ref);
	else setFile(ref);
}

function pickOption(option: string) {
	emit(
		'update:modelValue',
		pickedOption.value === option ? null : { kind: 'option', value: option }
	);
}

function onPicked(file: PickedFile) {
	setFile(file);
}

const isPickedCandidate = (candidate: { source: string; id: string }) =>
	pickedFiles.value.some((f) => isSameFile(f, candidate));

const busy = computed(() => uploading.value || resolving.value);
</script>

<template>
	<div class="mt-2 space-y-2" data-testid="file-ask">
		<ul v-if="multiple && pickedFiles.length > 0" class="space-y-1" data-testid="file-ask-files">
			<li
				v-for="file in pickedFiles"
				:key="`${file.source}:${file.id}`"
				class="flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-sm"
				data-testid="file-ask-picked"
			>
				<Icon name="lucide:paperclip" class="size-4 shrink-0 text-brand" aria-hidden="true" />
				<span class="min-w-0 flex-1 truncate text-text-primary">{{ file.filename }}</span>
				<button
					type="button"
					class="rounded p-0.5 text-text-tertiary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-brand"
					:aria-label="t('components.answer.fileAsk.remove', { file: file.filename })"
					:disabled="disabled"
					data-testid="file-ask-remove"
					@click="removeFile(file)"
				>
					<Icon name="lucide:x" class="size-4" aria-hidden="true" />
				</button>
			</li>
		</ul>
		<div
			v-if="!isFull"
			class="rounded-lg border border-dashed px-3 py-3 text-sm transition-colors duration-(--motion-fast)"
			:class="dragOver ? 'border-brand bg-brand/5' : 'border-border-default'"
			data-testid="file-ask-drop"
			@dragover="onDragOver"
			@dragleave="dragOver = false"
			@drop="onDrop"
		>
			<div v-if="picked && !multiple" class="flex items-center gap-2" data-testid="file-ask-picked">
				<Icon name="lucide:paperclip" class="size-4 shrink-0 text-brand" aria-hidden="true" />
				<span class="min-w-0 flex-1 truncate text-text-primary">{{ picked.filename }}</span>
				<button
					type="button"
					class="rounded p-0.5 text-text-tertiary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-brand"
					:aria-label="t('components.answer.fileAsk.remove', { file: picked.filename })"
					:disabled="disabled"
					data-testid="file-ask-remove"
					@click="emit('update:modelValue', null)"
				>
					<Icon name="lucide:x" class="size-4" aria-hidden="true" />
				</button>
			</div>
			<div v-else class="flex items-start gap-2">
				<Icon
					:name="busy ? 'lucide:loader-2' : 'lucide:upload'"
					class="mt-0.5 size-4 shrink-0 text-text-tertiary"
					:class="busy ? 'animate-spin motion-reduce:animate-none' : ''"
					aria-hidden="true"
				/>
				<div class="min-w-0">
					<p class="text-text-secondary">
						<template v-if="uploading">
							{{
								t('components.answer.fileAsk.uploading', { percent: Math.round(progress * 100) })
							}}
						</template>
						<template v-else>
							{{
								multiple && pickedFiles.length > 0
									? t('components.answer.fileAsk.dropAnother')
									: multiple
										? t('components.answer.fileAsk.dropHereMany')
										: t('components.answer.fileAsk.dropHere')
							}}
							<button
								type="button"
								class="font-medium text-brand underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand"
								:disabled="disabled || busy"
								data-testid="file-ask-choose"
								@click="choose"
							>
								{{ t('components.answer.fileAsk.choose') }}
							</button>
						</template>
					</p>
					<p class="mt-0.5 text-xs text-text-tertiary">
						{{
							attachedOnly
								? t('components.answer.fileAsk.attachedOnly')
								: copyPolicy === 'ifContact'
									? t('components.answer.fileAsk.attachedAndSavedIfContact')
									: t('components.answer.fileAsk.attachedAndSaved')
						}}
					</p>
				</div>
			</div>
		</div>

		<label
			v-if="
				!neverKept && (pickedFiles.length === 0 || pickedFiles.some((f) => f.source === 'upload'))
			"
			class="flex items-center gap-2 text-xs text-text-secondary"
		>
			<input
				v-model="dontKeep"
				type="checkbox"
				class="size-3.5 rounded border-border-default"
				:disabled="disabled"
				data-testid="file-ask-dont-keep"
			/>
			{{ t('components.answer.fileAsk.dontKeep') }}
		</label>

		<div v-if="candidates.length > 0">
			<p class="text-xs text-text-tertiary">
				{{
					nearMisses
						? t('components.answer.fileAsk.nearMisses')
						: t('components.answer.fileAsk.candidates')
				}}
			</p>
			<div class="mt-1 flex flex-wrap gap-1.5" role="group">
				<button
					v-for="candidate in candidates"
					:key="`${candidate.source}:${candidate.id}`"
					type="button"
					class="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs focus-visible:outline-2 focus-visible:outline-brand"
					:class="
						isPickedCandidate(candidate)
							? 'border-text-primary bg-text-primary text-text-inverse'
							: 'border-border-subtle text-text-secondary hover:border-text-tertiary hover:bg-bg-surface'
					"
					:aria-pressed="isPickedCandidate(candidate)"
					:disabled="disabled"
					data-testid="file-ask-candidate"
					@click="pickCandidate(candidate)"
				>
					<Icon name="lucide:file" class="size-3.5 shrink-0" aria-hidden="true" />
					<span class="truncate">{{ candidate.title?.trim() || candidate.filename }}</span>
					<span class="shrink-0 opacity-70">
						{{ formatCompactFileSize(candidate.size)
						}}<template v-if="candidate.note"> · {{ candidate.note }}</template>
					</span>
				</button>
			</div>
		</div>

		<div class="flex flex-wrap items-center gap-1.5">
			<button
				type="button"
				class="inline-flex items-center gap-1.5 rounded-full border border-border-subtle px-2.5 py-1 text-xs text-text-secondary hover:border-text-tertiary hover:bg-bg-surface focus-visible:outline-2 focus-visible:outline-brand"
				:disabled="disabled || isFull"
				data-testid="file-ask-pick-files"
				@click="pickerOpen = true"
			>
				<Icon name="lucide:folder-open" class="size-3.5" aria-hidden="true" />
				{{ t('components.answer.fileAsk.pickFromFiles') }}
			</button>
			<button
				v-for="option in optionChips"
				:key="option"
				type="button"
				class="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs focus-visible:outline-2 focus-visible:outline-brand"
				:class="
					pickedOption === option
						? 'border-text-primary bg-text-primary text-text-inverse'
						: 'border-border-subtle text-text-secondary hover:border-text-tertiary hover:bg-bg-surface'
				"
				:aria-pressed="pickedOption === option"
				:disabled="disabled"
				data-testid="file-ask-option"
				@click="pickOption(option)"
			>
				<Icon
					v-if="pickedOption === option"
					name="lucide:check"
					class="size-3"
					aria-hidden="true"
				/>
				{{ option }}
			</button>
		</div>

		<AnswerFilePicker v-model:open="pickerOpen" :mailbox-id="mailboxId" @pick="onPicked" />
	</div>
</template>
