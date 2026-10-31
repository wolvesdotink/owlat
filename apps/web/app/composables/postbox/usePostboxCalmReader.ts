/**
 * The calm reader's chrome state (read on arrival §3), kept out of
 * PostboxThreadReader.vue: what sits between the header and the first body.
 *
 *  - the one notice (`pickReaderNotice`: danger > key change > left draft >
 *    image consent) for EVERY expanded card: a danger on any of them is the
 *    thread's danger (no card repeats it), the latest message's image banner
 *    stays in place only when it IS the notice, and every other image banner
 *    goes into Details (`cardOf`);
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
import type { PostboxReaderCardChrome } from '~/composables/postbox/usePostboxReaderContext';

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
	/** The expanded cards: their banners share the one notice slot. */
	expanded: Ref<ReadonlySet<string>>;
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
	/** Each expanded card's image banner state, by message id. */
	const imageKinds = ref<Record<string, ImageKind>>({});
	const latestImage = computed<ImageKind>(() => {
		const id = opts.latest.value?._id;
		return (id && imageKinds.value[id]) || 'none';
	});
	watch(opts.threadKey, () => {
		detailsOpen.value = false;
		sheetOpen.value = false;
		asking.value = false;
		imageKinds.value = {};
	});

	const { left } = useAnswerLeftDraft();
	const hasLeftDraft = computed(() => {
		const id = left.value?.messageId;
		return !!id && opts.messages.value.some((m) => m._id === id);
	});

	/** The message the danger is about: the latest, else the first expanded one. */
	const dangerMessage = computed(() => {
		const latest = opts.latest.value;
		if (readerDangerOf(latest)) return latest;
		return opts.messages.value.find(
			(m) => opts.expanded.value.has(m._id) && readerDangerOf(m) !== null
		);
	});
	const danger = computed(() => readerDangerOf(dangerMessage.value));
	/** What a failed sender check means for this sender (the trust chip's own summary). */
	const dangerText = computed(() => {
		const message = dangerMessage.value;
		const key = message ? deriveSenderAuth(senderAuthInputOf(message))?.summary : undefined;
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

	/**
	 * A card's part in the one-page chrome: the LATEST card's chips render in
	 * Details; every card leaves the danger to the notice slot; image banners go
	 * to Details except the latest one's while it is the notice, and except on
	 * suspicious mail: its images never load on their own, so its "Show images"
	 * must stay beside the body, not in closed Details behind the danger notice.
	 */
	function cardOf(messageId: string): PostboxReaderCardChrome {
		const isLatest = messageId === opts.latest.value?._id;
		const details = opts.detailsEl.value ?? null;
		const inPlace = imageKinds.value[messageId] === 'suspicious';
		return {
			detailsTo: isLatest ? details : null,
			imageBannerTo: inPlace ? null : isLatest ? imageBannerTo.value : details,
			hideDanger: true,
		};
	}

	function onImageState(messageId: string, kind: ImageKind) {
		imageKinds.value = { ...imageKinds.value, [messageId]: kind };
	}

	const summary = computed(() => {
		const parts: string[] = [];
		if (opts.isSigned.value) parts.push(t('postbox.reader.summary.signed'));
		if (['blocked', 'suspicious', 'unchecked'].includes(latestImage.value))
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
		detailsOpen,
		sheetOpen,
		asking,
		notice,
		danger,
		dangerText,
		cardOf,
		onImageState,
		summary,
		openWhyHere,
	};
}
