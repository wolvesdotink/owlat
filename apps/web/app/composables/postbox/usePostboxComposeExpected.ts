/**
 * The composer's view of the files its draft owes (#1257): an RSVP's generated
 * `.ics`, a forward's attachments. The draft row is the record
 * (`mail/draftExpectedAttachments.ts` on the server), so every tab that shows
 * the draft agrees on what is still owed:
 *
 *  - an open that carries such files creates the row at once, asking it to owe
 *    them (`drafts.create`'s `expectedAttachments`). A forward is one debt
 *    ("Attachments of the forwarded message") until the server has read the
 *    message and expanded it into a chip per file;
 *  - whenever the row owes a file this mount has not tried yet (a reload, a
 *    second tab, another member's open), the server is asked to copy it on
 *    (`fulfil`). Any number of tabs may ask at once: each file lands once;
 *  - an owed file shows as an attachment chip that is still attaching, or has
 *    failed with Retry and Remove. Remove takes it out on the server, and a
 *    copy still in flight cannot bring it back;
 *  - the attachment chips follow the row's attachment list, so a file attached
 *    or taken out in another tab shows the same here;
 *  - `pending` holds Send while anything is owed (the server refuses the send
 *    too), and while a row the open asked to owe something has not answered.
 */
import { computed, onMounted, ref, watch, type Ref } from 'vue';
import type { FunctionArgs } from 'convex/server';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { ATTACHMENT_COMPOSE_LIMITS, MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import type { ComposerAttachment } from './usePostboxComposeAttachments';
import type { InitialHydrationState } from './usePostboxComposeHydration';
import type { UploadChip } from './postboxAttachmentUploads';

/** A file the app made for the composer to attach (plain text, a few KB). */
export interface GeneratedAttachment {
	filename: string;
	contentType: string;
	content: string;
}

export type ExpectedAttachmentRequest = NonNullable<
	FunctionArgs<typeof api.mail.drafts.create>['expectedAttachments']
>[number];

/** The chip id an owed file shows under, beside the upload chips. */
const CHIP_PREFIX = 'expected:';

/** What a seed asks its new row to owe. */
export function expectedAttachmentRequests(seed: {
	attachGenerated?: GeneratedAttachment;
	forwardAttachmentsFromMessageId?: Id<'mailMessages'>;
}): ExpectedAttachmentRequest[] {
	return [
		...(seed.attachGenerated ? [{ kind: 'generated' as const, ...seed.attachGenerated }] : []),
		...(seed.forwardAttachmentsFromMessageId
			? [{ kind: 'forward' as const, messageId: seed.forwardAttachmentsFromMessageId }]
			: []),
	];
}

interface OwedView {
	key: string;
	filename: string;
	contentType: string;
	size: number;
	state: 'owed' | 'attached' | 'removed';
	storageId?: string;
	isPlaceholder?: boolean;
}
interface RowView {
	attachments?: Array<ComposerAttachment & { isInline?: boolean }>;
	expectedAttachments?: OwedView[];
}
type Failure =
	| 'unreadable'
	| 'tooLarge'
	| 'tooMany'
	| 'totalTooLarge'
	| 'failed'
	| 'messageTooLarge'
	| 'messageTooComplex';

export function usePostboxComposeExpected(opts: {
	draftId: Readonly<Ref<Id<'mailDrafts'> | null>>;
	/** What the open asks the new row to owe. */
	requests: ExpectedAttachmentRequest[];
	ensureDraft: () => Promise<Id<'mailDrafts'> | null>;
	/** Whether a reopened row has been merged into the composer. */
	rowState: () => InitialHydrationState;
	/** The committed attachments the composer shows. */
	attachments: Ref<ComposerAttachment[]>;
}) {
	const { t, locale } = useI18n();
	const { showToast } = useToast();
	const rowQuery = useConvexQuery(api.mail.drafts.get, () =>
		opts.draftId.value ? { draftId: opts.draftId.value } : ('skip' as const)
	);
	const row = computed(() => rowQuery.data.value as RowView | null | undefined);
	const owed = computed(() =>
		(row.value?.expectedAttachments ?? []).filter((entry) => entry.state === 'owed')
	);

	const fulfilOp = useBackendOperation(api.mail.draftExpectedAttachmentsFulfil.fulfil, {
		label: () => t('shared.postbox.usePostboxComposeAttachments.attachOperation'),
		type: 'action',
		announce: false,
	});
	const removeOp = useBackendOperation(api.mail.draftExpectedAttachments.remove, {
		label: () => t('shared.postbox.usePostboxComposeAttachments.removeOperation'),
	});

	const failed = ref<Record<string, Failure>>({});
	const fulfilling = ref(false);
	// Keys this mount asked the server for: a failure is not retried on its own.
	const tried = new Set<string>();

	const pending = computed(
		() =>
			owed.value.length > 0 ||
			(opts.requests.length > 0 && (!opts.draftId.value || row.value === undefined))
	);

	const formatMb = (bytes: number) =>
		new Intl.NumberFormat(locale.value).format(bytes / 1024 / 1024);
	/** What a chip and a toast call an owed file. */
	const nameOf = (entry: Pick<OwedView, 'filename' | 'isPlaceholder'>) =>
		entry.isPlaceholder
			? t('shared.postbox.usePostboxComposeAttachments.forwardedAttachments')
			: entry.filename;

	function explain(filename: string, reason: Failure) {
		const base = 'shared.postbox.usePostboxComposeAttachments';
		const messages: Record<Failure, () => string> = {
			messageTooLarge: () => t(`${base}.forwardTooLarge`),
			messageTooComplex: () => t(`${base}.forwardTooComplex`),
			tooLarge: () => t(`${base}.tooLarge`, { filename, max: formatMb(MAX_ATTACHMENT_BYTES) }),
			tooMany: () => t(`${base}.tooManyFiles`, { count: ATTACHMENT_COMPOSE_LIMITS.maxCount }),
			totalTooLarge: () =>
				t(`${base}.totalTooLarge`, { max: formatMb(ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes) }),
			unreadable: () => t(`${base}.uploadFailed`, { filename }),
			failed: () => t(`${base}.uploadFailed`, { filename }),
		};
		showToast(messages[reason](), 'error');
	}

	async function fulfil() {
		const draftId = opts.draftId.value;
		if (!draftId || fulfilling.value) return;
		const asked = owed.value.map((entry) => entry.key);
		for (const key of asked) tried.add(key);
		fulfilling.value = true;
		try {
			const result = await fulfilOp.run({ draftId });
			const next: Record<string, Failure> = {};
			if (!result.ok) {
				for (const key of asked) next[key] = 'failed';
			} else {
				for (const miss of result.result.failed) {
					next[miss.key] = miss.reason;
					const entry = owed.value.find((e) => e.key === miss.key);
					explain(entry ? nameOf(entry) : miss.filename, miss.reason);
				}
			}
			failed.value = next;
		} finally {
			fulfilling.value = false;
		}
		if (owed.value.some((entry) => !tried.has(entry.key))) void fulfil();
	}

	watch(
		[() => owed.value.map((entry) => entry.key).join('\n'), opts.draftId, opts.rowState],
		() => {
			if (opts.rowState() !== 'ready') return;
			if (owed.value.some((entry) => !tried.has(entry.key))) void fulfil();
		},
		{ immediate: true }
	);

	// The chips follow the row: a file the server attached or took out (for this
	// tab, another tab, another member) shows the same everywhere, so no tab
	// offers a file the send would not carry. Only once a reopened row has been
	// merged, which fills the list from the row the first time.
	watch(
		[row, opts.rowState],
		([current, state]) => {
			if (!current?.attachments || state !== 'ready') return;
			const onRow = new Set(current.attachments.map((a) => a.storageId));
			const shown = new Set(opts.attachments.value.map((a) => a.storageId));
			const kept = opts.attachments.value.filter((a) => onRow.has(a.storageId));
			const added = current.attachments
				.filter((a) => !a.isInline && !shown.has(a.storageId))
				.map(({ storageId, filename, contentType, size }) => ({
					storageId,
					filename,
					contentType,
					size,
				}));
			if (kept.length < opts.attachments.value.length || added.length > 0) {
				opts.attachments.value = [...kept, ...added];
			}
		},
		{ immediate: true }
	);

	// An open that carries files makes its row now, so the server owes them.
	// An open that carries files makes its row now, so the server owes them.
	onMounted(() => {
		if (opts.requests.length > 0 && !opts.draftId.value) void opts.ensureDraft();
	});

	const chips = computed<UploadChip[]>(() =>
		owed.value.map((entry) => ({
			id: CHIP_PREFIX + entry.key,
			filename: nameOf(entry),
			contentType: entry.contentType,
			size: entry.size,
			status: failed.value[entry.key] && !fulfilling.value ? 'failed' : 'uploading',
			progress: 0,
			indeterminate: true,
			thumbUrl: null,
		}))
	);

	const keyOf = (chipId: string) =>
		chipId.startsWith(CHIP_PREFIX) ? chipId.slice(CHIP_PREFIX.length) : null;

	return {
		pending,
		chips,
		/** Handles a chip id of an owed file; false for any other chip. */
		remove(chipId: string): boolean {
			const key = keyOf(chipId);
			const draftId = opts.draftId.value;
			if (key === null) return false;
			if (draftId) void removeOp.run({ draftId, key });
			return true;
		},
		retry(chipId: string): boolean {
			const key = keyOf(chipId);
			if (key === null) return false;
			const { [key]: _retried, ...rest } = failed.value;
			failed.value = rest;
			void fulfil();
			return true;
		},
	};
}
