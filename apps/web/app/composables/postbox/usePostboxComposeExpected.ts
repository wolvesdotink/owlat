/**
 * The composer's view of the files its draft owes (#1257): an RSVP's generated
 * `.ics`, a forward's attachments. The draft row is the record
 * (`mail/draftExpectedAttachments.ts` on the server), so every tab that shows
 * the draft agrees on what is still owed:
 *
 *  - an open that carries such files creates the row at once, asking it to owe
 *    them (`drafts.create`'s `expectedAttachments`); a forward asks only when
 *    its message has file parts;
 *  - whenever the row owes a file this mount has not tried yet (a reload, a
 *    second tab, another member's open), the server is asked to copy it on
 *    (`fulfil`). Any number of tabs may ask at once: each file lands once;
 *  - an owed file shows as an attachment chip that is still attaching, or has
 *    failed with Retry and Remove. Remove takes it out on the server, and a
 *    copy still in flight cannot bring it back;
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
}
interface RowView {
	attachments?: ComposerAttachment[];
	expectedAttachments?: OwedView[];
}
type Failure = 'unreadable' | 'tooLarge' | 'tooMany' | 'totalTooLarge' | 'failed';

export function usePostboxComposeExpected(opts: {
	draftId: Readonly<Ref<Id<'mailDrafts'> | null>>;
	/** What the open asked the new row to owe. */
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

	const fulfilOp = useBackendOperation(api.mail.draftExpectedAttachments.fulfil, {
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
	function explain(filename: string, reason: Failure) {
		const base = 'shared.postbox.usePostboxComposeAttachments';
		const message =
			reason === 'tooLarge'
				? t(`${base}.tooLarge`, { filename, max: formatMb(MAX_ATTACHMENT_BYTES) })
				: reason === 'tooMany'
					? t(`${base}.tooManyFiles`, { count: ATTACHMENT_COMPOSE_LIMITS.maxCount })
					: reason === 'totalTooLarge'
						? t(`${base}.totalTooLarge`, { max: formatMb(ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes) })
						: t(`${base}.uploadFailed`, { filename });
		showToast(message, 'error');
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
					explain(miss.filename, miss.reason);
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

	// A file attached (or removed) by the server, possibly from another tab:
	// the chips follow the row. Only after a reopened row has been merged, which
	// fills the list from the row once.
	watch(
		[row, opts.rowState],
		([current, state]) => {
			if (!current || state !== 'ready') return;
			let next = opts.attachments.value;
			for (const entry of current.expectedAttachments ?? []) {
				if (!entry.storageId) continue;
				const shown = next.some((a) => a.storageId === entry.storageId);
				if (entry.state === 'attached' && !shown) {
					const landed = current.attachments?.find((a) => a.storageId === entry.storageId);
					if (landed) {
						const { storageId, filename, contentType, size } = landed;
						next = [...next, { storageId, filename, contentType, size }];
					}
				} else if (entry.state === 'removed' && shown) {
					next = next.filter((a) => a.storageId !== entry.storageId);
				}
			}
			if (next !== opts.attachments.value) opts.attachments.value = next;
		},
		{ immediate: true }
	);

	// An open that carries files makes its row now, so the server owes them.
	onMounted(() => {
		if (opts.requests.length > 0 && !opts.draftId.value) void opts.ensureDraft();
	});

	const chips = computed<UploadChip[]>(() =>
		owed.value.map((entry) => ({
			id: CHIP_PREFIX + entry.key,
			filename: entry.filename,
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
