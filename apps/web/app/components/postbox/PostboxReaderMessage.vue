<script setup lang="ts">
/**
 * ONE message inside the thread reader — collapsed header row or expanded card.
 *
 * Split out of PostboxThreadReader.vue so the reader shell keeps the
 * conversation-level concerns (queries, triage, shortcuts, dialogs) and this
 * file the per-message rendering. Presentational over semantic emits: the
 * reader owns the mutations, the auto-advance and the undo registration.
 *
 * Star / Reply / Reply-all / Forward stay visible; the ⋯ keeps genuine
 * overflow (spam, block, filter, print, original). The dark-render toggle,
 * delivery strip and scheduling chip live in the message-details disclosure.
 *
 * What every card of the reader shares (mailbox, flags, theme, Answer mode's
 * reduced cut, where the chrome renders) comes from the reader context, so
 * the props are per-message only. The calm reader (read on arrival §3) routes
 * the LATEST message's trust chip, unsubscribe chip and message details into
 * the strip's Details row instead of the card, and leaves the spam / DMARC
 * line to the thread's notice slot (`chromeOf`).
 */
import { extractEmailAddress } from '~/utils/emailAddress';
import { formatDateTime } from '~/utils/formatters';
import { deriveSenderAuth, senderAuthInputOf, type SenderAuthInput } from '~/utils/senderAuth';
import type { SecureMessageClass } from '@owlat/shared/secureMessage';
import type { TrackerDetection } from '@owlat/shared/postboxTrackers';
import type { OutboundDelivery } from '~/utils/postboxDeliveryStrip';
import type { RecipientKeyStatus } from '~/utils/recipientKeyStatus';
import type { PostboxReaderMessage } from './PostboxThreadReader.vue';
import type { AttachmentMeta } from '~/utils/attachmentMeta';
import { usePostboxSignedBody } from '~/composables/postbox/usePostboxSignedBody';
import { usePostboxReaderContext } from '~/composables/postbox/usePostboxReaderContext';
import type { CitedQuote } from '~/utils/postboxQuoteHighlight';
import { isCalendarInviteAttachment } from '~/utils/postboxSchedulingChip';
import type { PostboxBodyImageProps, PostboxImageBannerState } from '~/utils/postboxImageAllowlist';
import { ChevronDownIcon, MoonIcon, ShieldWarningIcon, SunIcon } from '@coolicons/vue';

const props = defineProps<{
	message: PostboxReaderMessage;
	expanded: boolean;
	/** Pre-formatted "24m" — the reader owns the minute tick that refreshes it. */
	relativeTime: string;
	starred: boolean;
	/** Whether Reply-all would add anyone beyond a plain Reply. */
	showReplyAll: boolean;
	/** False for our own messages — no VIP/accept-sender controls on ourselves. */
	showSenderControls: boolean;
	secureClass: SecureMessageClass;
	/** Encrypted or clearsigned — the badge renders the readable half instead. */
	hideBody: boolean;
	tracker?: TrackerDetection | null;
	delivery?: OutboundDelivery | null;
	/** Proposed times of a plain-prose scheduling request; null renders no chip. */
	schedulingTimes?: string[] | null;
	forcedLight: boolean;
	images: PostboxBodyImageProps;
	/** This message carries a real .ics invite (PostboxInviteCard renders it). */
	hasInvite: boolean;
	/** The correspondent's sealing-key status, when THIS sender is them. */
	sealStatus?: RecipientKeyStatus | null;
	/** The thread brief's latest-update sentence for this message (personal only). */
	latestLine?: string | null;
	/** A cited quote in this message: scroll to it and mark it (an empty quote scrolls only). */
	citeQuote?: CitedQuote | null;
}>();

const emit = defineEmits<{
	(e: 'toggle-expanded'): void;
	(e: 'open-sender-profile'): void;
	(e: 'toggle-forced-light'): void;
	(e: 'toggle-star'): void;
	(e: 'reply'): void;
	(e: 'reply-all'): void;
	(e: 'forward'): void;
	(e: 'report-spam'): void;
	(e: 'block-sender'): void;
	(e: 'create-filter'): void;
	(e: 'print'): void;
	(e: 'copy-link'): void;
	(e: 'share-in-chat'): void;
	(e: 'preview-attachment', att: AttachmentMeta, all: AttachmentMeta[]): void;
	(e: 'download-attachment', att: AttachmentMeta): void;
	(e: 'trackers', detection: TrackerDetection): void;
	(e: 'trust-sender', address: string): void;
	(e: 'untrust-sender', address: string): void;
	(e: 'resend', addresses: string[]): void;
	(e: 'use-reply', text: string): void;
	(e: 'dismiss-scheduling'): void;
	/** A sealing-key verification changed; the reader should re-read the status. */
	(e: 'seal-refetch'): void;
	(e: 'image-state', kind: PostboxImageBannerState['kind']): void;
}>();

const { t } = useI18n();

const msg = computed(() => props.message);
const reader = usePostboxReaderContext();
const chrome = computed(() => reader.chromeOf(msg.value._id));
// Find in conversation: the active match mounts its body even off screen.
const find = computed(() => reader.findOf(msg.value._id));
const findCount = computed(() => reader.findCountOf(msg.value._id));

// Reduced cards fold the recipient lines and details behind the sender name.
const metaOpen = ref(false);
const showMeta = computed(() => !reader.reduced || metaOpen.value);
function onSenderClick() {
	if (reader.reduced) metaOpen.value = !metaOpen.value;
	else emit('open-sender-profile');
}

const authInput = computed<SenderAuthInput>(() => senderAuthInputOf(msg.value));

// A clearsigned text body shows its signed block alone, and its verdict stands
// only beside that block, also when the text is stored rather than inline.
// `signedOnly` is the one gate for every surface below built from the message
// body (snippet, invite card, scheduling chip, tracker findings, attachment
// previews): a new one must read it too. Attachments are always read through
// `shownAttachments`, which drops a MIME message's detached signature part.
const {
	view: signedView,
	signedOnly,
	shownAttachments,
	hideBody: holdBody,
	secureClass: shownSecureClass,
	signature: shownSignature,
	badgeMessage,
} = usePostboxSignedBody({
	message: () => msg.value,
	secureClass: () => props.secureClass,
	hideBody: () => props.hideBody,
	active: () => props.expanded,
});
usePostboxSenderBodyOpen(props); // Senders §5: counts once a readable body is on screen

/**
 * The legacy DMARC-fail line. `senderAuthBadges` moved this into the auth badge;
 * with the flag off the banner is still the only place a DMARC failure is said
 * out loud, so it stays exactly as it was.
 */
const senderAuthSummary = computed(() => {
	// `summary` is a message key owned by utils/senderAuth (registry convention).
	const summary = deriveSenderAuth(authInput.value)?.summary;
	return summary
		? t(summary)
		: t('components.postbox.postboxThreadReader.senderCouldNotBeVerified');
});

const showSpamBanner = computed(
	() =>
		!chrome.value.hideDanger &&
		(msg.value.spamVerdict === 'spam' || (!reader.authEnabled && msg.value.dmarcResult === 'fail'))
);

// A cited quote: bring the message into view; the body marks the
// words, or reports that it could not find that exact passage.
const sectionEl = ref<HTMLElement | null>(null);
const isCiteMissed = ref(false);
watch(
	() => props.citeQuote,
	() => {
		isCiteMissed.value = false;
	}
);
watch(
	() => [props.citeQuote, props.expanded] as const,
	async ([quote, open]) => {
		if (quote == null || !open) return;
		await nextTick();
		sectionEl.value?.scrollIntoView({ block: 'start', behavior: 'auto' });
	},
	{ immediate: true }
);

const renderToggleLabel = computed(() =>
	props.forcedLight
		? t('components.postbox.postboxThreadReader.renderDark')
		: t('components.postbox.postboxThreadReader.renderLight')
);
</script>

<template>
	<!-- Collapsed message header -->
	<button
		v-if="!expanded"
		type="button"
		:data-message-id="msg._id"
		class="w-full flex items-center gap-3 px-4 py-2.5 rounded-md border border-border-subtle bg-bg-elevated text-left hover:bg-bg-surface"
		@click="emit('toggle-expanded')"
	>
		<UiAvatar
			:name="msg.fromName"
			:email="msg.fromAddress"
			deterministic-color
			size="md"
			class="flex-shrink-0"
			aria-hidden="true"
		/>
		<div class="flex-1 min-w-0">
			<p class="text-sm truncate">
				<span class="font-medium text-text-primary">{{ msg.fromName || msg.fromAddress }}</span>
				<template v-if="(latestLine || msg.snippet) && !signedOnly">
					<span class="text-text-tertiary mx-1.5">·</span>
					<span class="text-text-tertiary" :data-latest="latestLine ? '' : undefined">{{
						latestLine || msg.snippet
					}}</span>
				</template>
			</p>
		</div>
		<span
			v-if="findCount > 0"
			class="rounded bg-warning/15 px-1.5 text-xs tabular-nums text-text-secondary"
			data-testid="reader-message-find-count"
			>{{ t('components.postbox.threadFind.rowCount', { count: findCount }, findCount) }}</span
		>
		<span
			class="text-xs text-text-tertiary tabular-nums whitespace-nowrap flex-shrink-0"
			:title="formatDateTime(msg.receivedAt)"
		>
			{{ relativeTime }}
		</span>
	</button>

	<!-- Expanded message -->
	<section
		v-else
		ref="sectionEl"
		:data-message-id="msg._id"
		class="pbx-reader-message border border-border-subtle rounded-md bg-bg-elevated px-5 py-4 scroll-mt-4"
		:class="{ 'ring-1 ring-brand': citeQuote != null }"
	>
		<header class="flex items-start gap-3">
			<UiAvatar
				:name="msg.fromName"
				:email="msg.fromAddress"
				deterministic-color
				size="lg"
				class="flex-shrink-0"
				aria-hidden="true"
			/>
			<div class="flex-1 min-w-0">
				<!-- Wraps on a phone only: there the sender and the trust chip do not
				     fit one line, and the chip (never shrinking) ran off the card's
				     edge. The chip's group keeps to the right on the line it wraps
				     to, so its popover (anchored right) opens inside the card. From
				     `sm` up the row stays one line and the sender shrinks instead,
				     unless the reader pane (an `@container`) is itself under 32rem:
				     beside the list on a 1280px laptop the address otherwise broke
				     every few letters. -->
				<div
					class="flex items-baseline justify-between gap-x-3 gap-y-1 max-sm:flex-wrap @max-lg:flex-wrap"
					data-testid="reader-message-sender-row"
				>
					<!-- Plan idea 45: the sender line opens what the mailbox knows of them. -->
					<UiTooltip
						:text="
							reader.reduced
								? t('components.postbox.postboxReaderMessage.showDetails')
								: t('components.postbox.postboxSenderProfile.open')
						"
					>
						<button
							type="button"
							class="min-w-0 break-words text-left hover:underline"
							:aria-expanded="reader.reduced ? metaOpen : undefined"
							@click="onSenderClick"
						>
							<span class="font-medium text-text-primary">
								{{ msg.fromName || msg.fromAddress }}
							</span>
							<span v-if="msg.fromName" class="text-text-tertiary text-sm">
								&lt;{{ msg.fromAddress }}&gt;
							</span>
							<!-- Reduced, the name is a disclosure; say so without a hover. -->
							<ChevronDownIcon
								v-if="reader.reduced"
								class="ml-0.5 inline size-3.5 align-middle text-text-tertiary transition-transform motion-reduce:transition-none"
								:class="{ 'rotate-180': metaOpen }"
								aria-hidden="true"
								data-testid="reader-message-details-cue"
							/>
						</button>
					</UiTooltip>
					<div
						class="ml-auto flex max-w-full flex-shrink-0 items-center gap-2"
						data-testid="reader-message-indicators"
					>
						<!-- Five indicators, one pixel budget: the popover holds the auth
						     badge, security / sealed badge, trackers, sealing key, controls. -->
						<Teleport :to="chrome.detailsTo" :disabled="!chrome.detailsTo"
							><PostboxTrustChip
								:mailbox-id="reader.mailboxId"
								:from-address="msg.fromAddress"
								:auth-enabled="reader.authEnabled"
								:auth="authInput"
								:heuristics="msg.senderHeuristics"
								:sealed-enabled="reader.sealedEnabled"
								:sealed="msg.inboundEncryptionInfo"
								:signature="shownSignature"
								:secure-class="shownSecureClass"
								:message="msg"
								:tracker="signedOnly ? null : tracker"
								:show-sender-controls="showSenderControls"
								:seal-status="sealStatus"
								:show-security-detail="!holdBody"
								:hide-when-ok="reader.reduced"
								@seal-refetch="emit('seal-refetch')"
						/></Teleport>
						<UiTooltip :text="formatDateTime(msg.receivedAt)">
							<button
								type="button"
								class="text-xs text-text-tertiary tabular-nums whitespace-nowrap hover:text-text-primary"
								@click="emit('toggle-expanded')"
							>
								{{ relativeTime }}
							</button>
						</UiTooltip>
					</div>
				</div>
				<p v-if="showMeta" class="text-text-secondary text-xs mt-0.5">
					{{
						t('components.postbox.postboxThreadReader.toLine', {
							recipients: msg.toAddresses.join(', '),
						})
					}}
					<span v-if="msg.ccAddresses.length > 0">
						{{
							t('components.postbox.postboxThreadReader.ccLine', {
								recipients: msg.ccAddresses.join(', '),
							})
						}}
					</span>
				</p>
				<button
					v-if="reader.reduced && metaOpen"
					type="button"
					class="mt-1 text-xs text-brand hover:underline"
					@click="emit('open-sender-profile')"
				>
					{{ t('components.postbox.postboxSenderProfile.open') }}
				</button>
				<Teleport :to="chrome.detailsTo" :disabled="!chrome.detailsTo">
					<PostboxUnsubscribeChip
						v-if="msg.unsubscribe && showMeta"
						class="mt-1.5"
						:message-id="msg._id"
						:mailbox-id="reader.mailboxId"
						:unsubscribe="msg.unsubscribe"
						:sender-name="msg.fromName || msg.fromAddress"
					/>
					<!-- The badge's claims, made checkable: the real headers behind them,
				     the original .eml (UX plan idea 52) — and, in the slot, the three
				     message-scoped details that do not earn permanent chrome. -->
					<PostboxMessageDetails v-if="showMeta" :message-id="msg._id">
						<button
							v-if="reader.appIsDark"
							type="button"
							class="mt-3 inline-flex items-center gap-1.5 text-text-tertiary hover:text-text-primary"
							:aria-label="renderToggleLabel"
							:aria-pressed="forcedLight"
							@click="emit('toggle-forced-light')"
						>
							<component :is="forcedLight ? MoonIcon : SunIcon" class="w-3.5 h-3.5" />
							{{ renderToggleLabel }}
						</button>

						<!-- Quiet "draft a reply?" prompt for a plain-prose scheduling
					     request. Never renders beside a real .ics invite. -->
						<PostboxSchedulingChip
							v-if="schedulingTimes && !signedOnly"
							:message-id="msg._id"
							:proposed-times="schedulingTimes"
							@use-reply="(text) => emit('use-reply', text)"
							@dismiss="emit('dismiss-scheduling')"
						/>

						<!-- What actually happened to a message WE sent (plan idea 1): one
					     row per recipient, plus a resend that targets only the ones it
					     never reached. Renders nothing for inbound mail (no `outbound`
					     record) and nothing for the ordinary single-recipient send that
					     simply went out. -->
						<PostboxDeliveryStrip
							v-if="delivery"
							:delivery="delivery"
							@resend="(addresses) => emit('resend', addresses)"
						/>
					</PostboxMessageDetails>
				</Teleport>
			</div>
		</header>

		<!-- DMARC fails show in PostboxAuthBadge behind `senderAuthBadges`; with the
		     flag off this legacy line still says it. Spam always shows here. -->
		<p
			v-if="citeQuote?.quote && (isCiteMissed || holdBody)"
			role="status"
			class="mt-3 rounded bg-bg-surface px-3 py-2 text-xs text-text-secondary"
			data-testid="cite-not-located"
		>
			{{ t('components.brief.cite.notLocated') }}
		</p>
		<div
			v-if="showSpamBanner"
			class="my-3 px-3 py-2 rounded bg-warning/10 text-warning text-xs flex items-center gap-2"
		>
			<ShieldWarningIcon class="w-4 h-4" />
			<span v-if="msg.spamVerdict === 'spam'">{{
				t('components.postbox.postboxThreadReader.markedAsSpam')
			}}</span>
			<span v-else>{{ senderAuthSummary }}</span>
		</div>

		<!-- A signature verdict about a text body that is still loading: nothing
		     renders until the signed block can be picked out of it. -->
		<div
			v-if="signedView.kind === 'loading'"
			class="mt-4"
			aria-busy="true"
			data-testid="signed-body-loading"
		>
			<p class="sr-only" role="status">
				{{ t('components.postbox.postboxReaderMessage.loadingSignedText') }}
			</p>
			<PostboxReaderSkeleton :with-header="false" />
		</div>
		<!-- Ciphertext or clearsigned text: the security badge IS the readable half
		     (plus the copy / download recovery controls), so it renders where the
		     body would have been rather than inside the trust chip. -->
		<PostboxSecurityBadge
			v-else-if="holdBody"
			:klass="shownSecureClass"
			:message="badgeMessage"
			:sealed="reader.sealedEnabled ? msg.inboundEncryptionInfo : undefined"
			:signature="shownSignature"
			:omits-content="signedView.kind === 'signed' && signedView.omitsContent"
		/>
		<!-- Off-screen bodies wait as a sized placeholder until near the viewport. -->
		<PostboxLazyBody
			v-else
			:message-id="msg._id"
			:force-light="forcedLight"
			:images="images"
			:eager="reader.eagerBody || find?.active != null"
		>
			<PostboxMessageBody
				:message="msg"
				:force-light="forcedLight"
				v-bind="images"
				:highlight-quote="citeQuote"
				:find="find"
				:image-banner-to="chrome.imageBannerTo"
				@image-state="emit('image-state', $event)"
				@cite-located="isCiteMissed = !$event"
				@trackers="emit('trackers', $event)"
				@trust-sender="emit('trust-sender', $event)"
				@untrust-sender="emit('untrust-sender', $event)"
			/>
		</PostboxLazyBody>

		<!-- Under `signedOnly` an invite is a part the signature does not cover:
		     listed below as an attachment, never rendered as a card. -->
		<PostboxInviteCard
			v-if="hasInvite && !signedOnly && shownAttachments.some(isCalendarInviteAttachment)"
			:message-id="msg._id"
			:mailbox-id="reader.mailboxId"
			:own-email="reader.ownEmail"
		/>

		<PostboxMessageAttachments
			:attachments="shownAttachments"
			:message-id="msg._id"
			:downloading-key="reader.downloadingAttachment"
			:is-preview-enabled="!signedOnly"
			:indexing="msg.attachmentIndexing"
			@preview="(att, all) => emit('preview-attachment', att, all)"
			@download="(att) => emit('download-attachment', att)"
		/>

		<!-- Star / Reply / Reply all / Forward / ⋯. Answer mode drops the row:
		     you are already replying, and the rest stays in the normal reader. -->
		<PostboxReaderMessageActions
			v-if="!reader.reduced"
			:message-id="msg._id"
			:starred="starred"
			:show-reply-all="showReplyAll"
			@toggle-star="emit('toggle-star')"
			@reply="emit('reply')"
			@reply-all="emit('reply-all')"
			@forward="emit('forward')"
			@report-spam="emit('report-spam')"
			@block-sender="emit('block-sender')"
			@create-filter="emit('create-filter')"
			@print="emit('print')"
			@copy-link="emit('copy-link')"
			@share-in-chat="emit('share-in-chat')"
		/>
	</section>
</template>
