/**
 * The composer's side of its expected attachments (the record is
 * `usePostboxExpectedAttachments`'): what the open asked it to attach, and what
 * a reopened draft still owes from an earlier mount (#1257).
 *
 *  - An open that carries a generated file or a forward records them on the
 *    draft the moment its row exists (in the same step that the compose page
 *    drops them from its request), then uploads them. A forward reads the
 *    message first: one with nothing to copy creates no row.
 *  - Once the row has loaded, each file still pending is resolved exactly
 *    once: on the row already (done); its recorded upload attached again (it
 *    may have landed after the page went; the server takes a repeat as done);
 *    otherwise uploaded again from its source.
 *  - `pending` holds Send until every expected file is on the row, has been
 *    removed by the person, or was refused by a compose limit. A failed upload
 *    keeps its chip (retry or remove) and keeps holding Send.
 *
 * Split out of `usePostboxComposeAttachments` for the file-size ratchet; the
 * transport (upload chips, the attach mutation) stays there.
 */
import { computed, onMounted, ref, shallowRef, watch, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import type { ComposerAttachment } from './usePostboxComposeAttachments';
import type { InitialHydrationState } from './usePostboxComposeHydration';
import { composeRandomId } from './usePostboxComposeNav';
import {
	expectedRecordOpen,
	usePostboxExpectedAttachments,
	type ExpectedFile,
	type ExpectedRecord,
	type ExpectedSource,
} from './usePostboxExpectedAttachments';

/** Where a tracked upload's file sits in its draft's record. */
interface Slot {
	draftId: string;
	entry: number;
	file: number;
}

export function usePostboxComposeExpected(opts: {
	draftId: Readonly<Ref<Id<'mailDrafts'> | null>>;
	/** What the open asked to attach (its creation-time instructions). */
	sources: ExpectedSource[];
	ensureDraft: () => Promise<Id<'mailDrafts'> | null>;
	onCreated?: (listener: (id: Id<'mailDrafts'>) => void) => () => void;
	/** Whether a reopened row has reached the composer. */
	rowState: () => InitialHydrationState;
	/** The committed attachments (the row's, once it has loaded). */
	attachments: Ref<ComposerAttachment[]>;
	/** The compose limits: the files that may be uploaded (refusals are toasted). */
	admit: (files: File[]) => File[];
	/** Start an upload chip per file; returns their ids, in order. */
	upload: (files: File[]) => string[];
	/** Attach an upload that may already be on the row; false when it was not taken. */
	reattach: (attachment: ComposerAttachment) => Promise<boolean>;
	/** A forwarded message's attachment files, or null when it cannot be read. */
	loadForward: (messageId: Id<'mailMessages'>) => Promise<File[] | null>;
}) {
	const store = usePostboxExpectedAttachments();
	const mount = composeRandomId();
	const { sources } = opts;

	// Upload chips carrying an expected file, by chip id.
	const tracked = shallowRef<Record<string, Slot>>({});
	// Between the open (or a reopen that owes files) and the uploads starting.
	const resolving = ref(
		sources.length > 0 ||
			(!!opts.draftId.value && expectedRecordOpen(store.read(opts.draftId.value)))
	);
	const pending = computed(() => resolving.value || Object.keys(tracked.value).length > 0);

	// The record is written in the same step the row is created (and the compose
	// page drops the instructions from its request), so no moment holds neither.
	if (sources.length > 0) opts.onCreated?.((id) => store.begin(String(id), sources));

	const forwardLoads = new Map<string, Promise<File[] | null>>();
	function filesOf(source: ExpectedSource): Promise<File[] | null> {
		if (source.kind === 'generated') {
			const { content, filename, contentType } = source.attachment;
			return Promise.resolve([new File([content], filename, { type: contentType })]);
		}
		let load = forwardLoads.get(source.messageId);
		if (!load) {
			load = opts.loadForward(source.messageId).catch(() => null);
			forwardLoads.set(source.messageId, load);
		}
		return load;
	}

	const describe = (file: File): ExpectedFile => ({
		filename: file.name,
		contentType: file.type || 'application/octet-stream',
		size: file.size,
		state: 'pending',
	});

	function change(draftId: string, fn: (record: ExpectedRecord) => ExpectedRecord): boolean {
		return store.update(draftId, mount, fn);
	}

	function patchFile(slot: Slot, patch: Partial<ExpectedFile>): boolean {
		return change(slot.draftId, (record) => ({
			...record,
			entries: record.entries.map((entry, e) =>
				e !== slot.entry || !entry.files
					? entry
					: {
							...entry,
							files: entry.files.map((file, f) => (f === slot.file ? { ...file, ...patch } : file)),
						}
			),
		}));
	}

	const onRow = (storageId: string) =>
		opts.attachments.value.some((a) => a.storageId === storageId);

	/** Resolves true once the row has loaded, false when it never will. */
	function rowReady(): Promise<boolean> {
		return new Promise((resolve) => {
			const stop = watch(
				opts.rowState,
				(state) => {
					if (state !== 'ready' && state !== 'missing') return;
					queueMicrotask(() => stop());
					resolve(state === 'ready');
				},
				{ immediate: true }
			);
		});
	}

	let resumedFor: string | null = null;
	async function resume(draftId: string) {
		resumedFor = draftId;
		store.begin(draftId, sources);
		if (!expectedRecordOpen(store.read(draftId))) {
			resolving.value = false;
			return;
		}
		resolving.value = true;
		try {
			if (!(await rowReady()) || opts.draftId.value !== draftId) return;
			const record = store.claim(draftId, mount);
			if (!record || record.settled) return;

			const toUpload: {
				slot: Slot;
				want: ExpectedFile;
				bytes: File | null;
				source: ExpectedSource;
			}[] = [];
			for (const [e, entry] of record.entries.entries()) {
				let files = entry.files;
				let read: File[] | null = null;
				if (files === null) {
					read = (await filesOf(entry.source)) ?? [];
					const described = read.map(describe);
					if (!change(draftId, (r) => withEntryFiles(r, e, described))) return;
					files = described;
				}
				for (const [f, file] of files.entries()) {
					if (file.state !== 'pending') continue;
					const slot = { draftId, entry: e, file: f };
					if (await resolvedOnRow(slot, file)) continue;
					toUpload.push({ slot, want: file, bytes: read?.[f] ?? null, source: entry.source });
				}
			}

			// Upload again what is not on the row, from its source.
			const files: File[] = [];
			const slots: Slot[] = [];
			for (const item of toUpload) {
				const bytes = item.bytes ?? (await filesOf(item.source))?.[item.slot.file] ?? null;
				if (!bytes || bytes.name !== item.want.filename || bytes.size !== item.want.size) {
					// The source no longer gives this file: it cannot be attached.
					patchFile(item.slot, { state: 'dropped' });
					continue;
				}
				files.push(bytes);
				slots.push(item.slot);
			}
			if (files.length === 0 || opts.draftId.value !== draftId) return;
			const admitted = opts.admit(files);
			const chipIds = opts.upload(admitted);
			const next = { ...tracked.value };
			for (const [k, file] of files.entries()) {
				const at = admitted.indexOf(file);
				if (at < 0) patchFile(slots[k]!, { state: 'dropped' });
				else next[chipIds[at]!] = slots[k]!;
			}
			tracked.value = next;
		} finally {
			if (resumedFor === draftId) resolving.value = false;
		}
	}

	/**
	 * Settle one pending file without uploading it, when it is (or can be put)
	 * on the row: its recorded upload is there, or attaching it again lands.
	 */
	async function resolvedOnRow(slot: Slot, file: ExpectedFile): Promise<boolean> {
		const { storageId } = file;
		if (!storageId) return false;
		if (!onRow(storageId)) {
			const attachment: ComposerAttachment = {
				storageId,
				filename: file.filename,
				contentType: file.contentType,
				size: file.size,
			};
			// A server before the repeat-is-done rule refuses an upload it holds,
			// so a refusal is looked up on the row before uploading again.
			if (!(await opts.reattach(attachment)) && !onRow(storageId)) {
				patchFile(slot, { storageId: undefined });
				return false;
			}
			if (!onRow(storageId)) opts.attachments.value = [...opts.attachments.value, attachment];
		}
		patchFile(slot, { state: 'done' });
		return true;
	}

	/** Open with instructions and no row: make the row (a forward only when it copies something). */
	async function create() {
		if (sources.every((source) => source.kind === 'forward')) {
			const lists = await Promise.all(sources.map(filesOf));
			if (lists.every((list) => !list || list.length === 0)) {
				// Nothing to copy; a row made meanwhile records (and settles) that.
				if (!opts.draftId.value) resolving.value = false;
				return;
			}
		}
		// The row's id starts the uploads (below); a failed create keeps Send held.
		await opts.ensureDraft();
	}

	onMounted(() => {
		watch(
			opts.draftId,
			(id) => {
				if (id && resumedFor !== id) void resume(id);
			},
			{ immediate: true }
		);
		if (!opts.draftId.value && sources.length > 0) void create();
	});

	function take(chipId: string): Slot | null {
		const slot = tracked.value[chipId];
		if (!slot) return null;
		const { [chipId]: _taken, ...rest } = tracked.value;
		tracked.value = rest;
		return slot;
	}

	return {
		pending,
		/**
		 * An upload finished and is about to be attached: record it first. False
		 * when another mount has taken the draft over (it must not be attached).
		 */
		beforeAttach(chipId: string, storageId: string): boolean {
			const slot = tracked.value[chipId];
			return slot ? patchFile(slot, { storageId }) : true;
		},
		committed(chipId: string) {
			const slot = take(chipId);
			if (slot) patchFile(slot, { state: 'done' });
		},
		/** The person removed the chip: this file is no longer expected. */
		dismissed(chipId: string) {
			const slot = take(chipId);
			if (slot) patchFile(slot, { state: 'dropped' });
		},
	};
}

function withEntryFiles(record: ExpectedRecord, entry: number, files: ExpectedFile[]) {
	return {
		...record,
		entries: record.entries.map((e, i) => (i === entry ? { ...e, files } : e)),
	};
}
