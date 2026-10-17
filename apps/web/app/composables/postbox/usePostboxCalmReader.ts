/**
 * The calm reader's chrome state (read on arrival §3, plan §6), kept out of
 * PostboxThreadReader.vue: what sits between the header and the first body.
 *
 *  - the one notice (`pickReaderNotice`: danger > key change > left draft >
 *    image consent), and where the latest message's image banner goes: in
 *    place when it IS the notice, else into Details;
 *  - Details open or closed (the strip's link and the header ⋯ both open it),
 *    the panel the latest message's chips teleport into, and its quiet
 *    summary ("signed · images off");
 *  - the Full brief sheet and "Ask about this thread";
 *  - "Why here?", handed to whatever lane learn provides (usePostboxWhyHere).
 *
 * Every piece resets when another thread opens.
 */
import type { Ref } from 'vue';
import type { Placement } from '@owlat/shared/arrival';
import type { PostboxImageBannerState } from '~/utils/postboxImageAllowlist';
import { pickReaderNotice, readerDangerOf } from '~/utils/postboxReaderNotice';
import { useAnswerLeftDraft } from '~/composables/useAnswerMode';
import { usePostboxWhyHere } from '~/composables/postbox/usePostboxWhyHere';
import { deriveSenderAuth, senderAuthInputOf, type SenderAuthMessage } from '~/utils/senderAuth';

type ImageKind = PostboxImageBannerState['kind'];

interface CalmReaderMessage extends SenderAuthMessage {
	_id: string;
	spamVerdict?: string;
}

export function usePostboxCalmReader(opts: {
	threadKey: () => string;
	mailboxId: () => string;
	threadId: () => string | undefined;
	/** The thread's effective placement (override, else arrival), when projected. */
	placement: () => Placement | undefined;
	messages: Ref<readonly CalmReaderMessage[]>;
	latest: Ref<CalmReaderMessage | undefined>;
	keyChanged: Ref<boolean>;
	/** A message of the thread is clearsigned. */
	isSigned: Ref<boolean>;
	/** The strip's Details panel element (the teleport target). */
	detailsEl: Ref<HTMLElement | null>;
}) {
	const { t } = useI18n();
	const detailsOpen = ref(false);
	const sheetOpen = ref(false);
	const asking = ref(false);
	const latestImage = ref<ImageKind>('none');
	watch(opts.threadKey, () => {
		detailsOpen.value = false;
		sheetOpen.value = false;
		asking.value = false;
		latestImage.value = 'none';
	});

	const { left } = useAnswerLeftDraft();
	const hasLeftDraft = computed(() => {
		const id = left.value?.messageId;
		return !!id && opts.messages.value.some((m) => m._id === id);
	});

	const danger = computed(() => readerDangerOf(opts.latest.value));
	/** What a DMARC failure means for this sender (the trust chip's own summary). */
	const dangerText = computed(() => {
		const latest = opts.latest.value;
		const key = latest ? deriveSenderAuth(senderAuthInputOf(latest))?.summary : undefined;
		return key ? t(key) : '';
	});
	const notice = computed(() =>
		pickReaderNotice({
			danger: danger.value !== null,
			keyChange: opts.keyChanged.value,
			leftDraft: hasLeftDraft.value,
			images: latestImage.value !== 'none',
		})
	);

	/** Where the latest message's image banner renders: in place only when it is the notice. */
	const imageBannerTo = computed(() =>
		notice.value === 'images' ? null : (opts.detailsEl.value ?? null)
	);

	function onImageState(messageId: string, kind: ImageKind) {
		if (messageId === opts.latest.value?._id) latestImage.value = kind;
	}

	const summary = computed(() => {
		const parts: string[] = [];
		if (opts.isSigned.value) parts.push(t('postbox.reader.summary.signed'));
		if (latestImage.value === 'blocked' || latestImage.value === 'unchecked')
			parts.push(t('postbox.reader.summary.imagesOff'));
		return parts.join(' · ') || null;
	});

	const whyHere = usePostboxWhyHere();
	function openWhyHere(anchor: HTMLElement | null) {
		const threadId = opts.threadId();
		if (!threadId) return;
		const placement = opts.placement();
		whyHere.open({
			mailboxId: opts.mailboxId(),
			threadId,
			...(placement ? { placement } : {}),
			anchor,
		});
	}

	return {
		detailsEl: opts.detailsEl,
		detailsOpen,
		sheetOpen,
		asking,
		notice,
		danger,
		dangerText,
		imageBannerTo,
		onImageState,
		summary,
		openWhyHere,
	};
}
