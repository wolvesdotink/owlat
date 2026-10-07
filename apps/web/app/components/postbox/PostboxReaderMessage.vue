<script setup lang="ts">
/**
 * ONE message inside the thread reader — collapsed header row or expanded card.
 *
 * Split out of PostboxThreadReader.vue (which was 1571 lines and rendered this
 * whole card inline) so the reader shell keeps the conversation-level concerns
 * — queries, triage, shortcuts, dialogs — and this file keeps the per-message
 * rendering. Purely presentational over semantic emits: every verb it offers is
 * handed back to the reader, which owns the mutations, the auto-advance and the
 * undo registration. Behaviour is unchanged by the move.
 *
 * The composer's diet applied to a message (plan §05):
 *   • Star / Reply / Reply-all / Forward stay visible.
 *   • The ⋯ keeps only genuine overflow — report spam, block sender, create a
 *     filter from this message, print, download the original. Reply-all and
 *     Forward left it because they are visible; mute and notify-on-reply left it
 *     because they are conversation state and live in the thread ⋯ menu.
 *   • The dark-render toggle, delivery strip and scheduling chip moved into the
 *     message-details disclosure, which already existed right there.
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

const props = defineProps<{
	message: PostboxReaderMessage;
	/** The reader's mailbox — the thread's, not necessarily this message's. */
	mailboxId: string;
	expanded: boolean;
	/** Pre-formatted "24m" — the reader owns the minute tick that refreshes it. */
	relativeTime: string;
	starred: boolean;
	/** Whether Reply-all would add anyone beyond a plain Reply. */
	showReplyAll: boolean;
	/** False for our own messages — no VIP/accept-sender controls on ourselves. */
	showSenderControls: boolean;
	/** Feature flag `senderAuthBadges`. */
	authEnabled: boolean;
	/** Feature flag `sealedMail`. */
	sealedEnabled: boolean;
	secureClass: SecureMessageClass;
	/** Encrypted or clearsigned — the badge renders the readable half instead. */
	hideBody: boolean;
	tracker?: TrackerDetection | null;
	delivery?: OutboundDelivery | null;
	/** Proposed times of a plain-prose scheduling request; null renders no chip. */
	schedulingTimes?: string[] | null;
	/** The app is in dark mode, so the per-message light-render escape hatch applies. */
	showRenderToggle: boolean;
	forcedLight: boolean;
	imagesAllowed: boolean;
	ownEmail?: string;
	/** This message carries a real .ics invite (PostboxInviteCard renders it). */
	hasInvite: boolean;
	/** The correspondent's sealing-key status, when THIS sender is them. */
	sealStatus?: RecipientKeyStatus | null;
	/** `${messageId}:${part}` of the attachment currently being fetched, if any. */
	downloadingAttachment?: string | null;
	/** Mount the body now instead of when it nears the viewport (printing). */
	eagerBody?: boolean;
	/**
	 * Answer mode's cut of the card (plan §09): no action row, the trust chip
	 * only when the sender is not verified, and To/Cc, the unsubscribe chip and
	 * the message details behind a click on the sender name.
	 */
	reduced?: boolean;
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
}>();

const { t } = useI18n();

const msg = computed(() => props.message);

// Reduced cards fold the recipient lines and details behind the sender name.
const metaOpen = ref(false);
const showMeta = computed(() => !props.reduced || metaOpen.value);
function onSenderClick() {
	if (props.reduced) metaOpen.value = !metaOpen.value;
	else emit('open-sender-profile');
}

const authInput = computed<SenderAuthInput>(() => senderAuthInputOf(msg.value));

// A clearsigned text body shows its signed block alone, and its verdict stands
// only beside that block, also when the text is stored rather than inline.
const {
	view: signedView,
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
	() => msg.value.spamVerdict === 'spam' || (!props.authEnabled && msg.value.dmarcResult === 'fail')
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
				<template v-if="msg.snippet">
					<span class="text-text-tertiary mx-1.5">·</span>
					<span class="text-text-tertiary">{{ msg.snippet }}</span>
				</template>
			</p>
		</div>
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
		class="pbx-reader-message border border-border-subtle rounded-md bg-bg-elevated px-5 py-4"
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
					<!-- Plan idea 45: the sender line was a text label. It now opens
					     everything this mailbox knows about the person. -->
					<button
						type="button"
						class="min-w-0 break-words text-left hover:underline"
						:title="
							reduced
								? t('components.postbox.postboxReaderMessage.showDetails')
								: t('components.postbox.postboxSenderProfile.open')
						"
						:aria-expanded="reduced ? metaOpen : undefined"
						@click="onSenderClick"
					>
						<span class="font-medium text-text-primary">
							{{ msg.fromName || msg.fromAddress }}
						</span>
						<span v-if="msg.fromName" class="text-text-tertiary text-sm">
							&lt;{{ msg.fromAddress }}&gt;
						</span>
						<!-- Reduced, the name is a disclosure; say so without a hover. -->
						<Icon
							v-if="reduced"
							name="lucide:chevron-down"
							class="ml-0.5 inline size-3.5 align-middle text-text-tertiary transition-transform motion-reduce:transition-none"
							:class="{ 'rotate-180': metaOpen }"
							aria-hidden="true"
							data-testid="reader-message-details-cue"
						/>
					</button>
					<div
						class="ml-auto flex max-w-full flex-shrink-0 items-center gap-2"
						data-testid="reader-message-indicators"
					>
						<!-- Five indicators, one pixel budget: the popover still holds the
						     auth badge, the security / sealed badge, the tracker findings,
						     the correspondent's sealing key and the sender controls. -->
						<PostboxTrustChip
							:mailbox-id="mailboxId"
							:from-address="msg.fromAddress"
							:auth-enabled="authEnabled"
							:auth="authInput"
							:heuristics="msg.senderHeuristics"
							:sealed-enabled="sealedEnabled"
							:sealed="msg.inboundEncryptionInfo"
							:signature="shownSignature"
							:secure-class="shownSecureClass"
							:message="msg"
							:tracker="tracker"
							:show-sender-controls="showSenderControls"
							:seal-status="sealStatus"
							:show-security-detail="!holdBody"
							:hide-when-ok="reduced"
							@seal-refetch="emit('seal-refetch')"
						/>
						<button
							type="button"
							class="text-xs text-text-tertiary tabular-nums whitespace-nowrap hover:text-text-primary"
							:title="formatDateTime(msg.receivedAt)"
							@click="emit('toggle-expanded')"
						>
							{{ relativeTime }}
						</button>
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
					v-if="reduced && metaOpen"
					type="button"
					class="mt-1 text-xs text-brand hover:underline"
					@click="emit('open-sender-profile')"
				>
					{{ t('components.postbox.postboxSenderProfile.open') }}
				</button>
				<PostboxUnsubscribeChip
					v-if="msg.unsubscribe && showMeta"
					class="mt-1.5"
					:message-id="msg._id"
					:mailbox-id="mailboxId"
					:unsubscribe="msg.unsubscribe"
				/>
				<!-- The badge's claims, made checkable: the real headers behind them,
				     the original .eml (UX plan idea 52) — and, in the slot, the three
				     message-scoped details that used to be permanent chrome. -->
				<PostboxMessageDetails v-if="showMeta" :message-id="msg._id">
					<button
						v-if="showRenderToggle"
						type="button"
						class="mt-3 inline-flex items-center gap-1.5 text-text-tertiary hover:text-text-primary"
						:title="renderToggleLabel"
						:aria-label="renderToggleLabel"
						:aria-pressed="forcedLight"
						@click="emit('toggle-forced-light')"
					>
						<Icon :name="forcedLight ? 'lucide:moon' : 'lucide:sun'" class="w-3.5 h-3.5" />
						{{ renderToggleLabel }}
					</button>

					<!-- Quiet "draft a reply?" prompt for a plain-prose scheduling
					     request. Never renders beside a real .ics invite. -->
					<PostboxSchedulingChip
						v-if="schedulingTimes"
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
			</div>
		</header>

		<!-- The ad-hoc DMARC-fail line moved into PostboxAuthBadge (in the sender
		     header) behind `senderAuthBadges`. When the flag is off the legacy
		     banner still surfaces a DMARC failure so behavior is unchanged; the
		     spam line always shows. -->
		<div
			v-if="showSpamBanner"
			class="my-3 px-3 py-2 rounded bg-warning/10 text-warning text-xs flex items-center gap-2"
		>
			<Icon name="lucide:shield-alert" class="w-4 h-4" />
			<span v-if="msg.spamVerdict === 'spam'">{{
				t('components.postbox.postboxThreadReader.markedAsSpam')
			}}</span>
			<span v-else>{{ senderAuthSummary }}</span>
		</div>

		<!-- A signature verdict about a text body that is still loading: nothing
		     renders until the signed block can be picked out of it. -->
		<div v-if="signedView.kind === 'loading'" class="mt-4" data-testid="signed-body-loading">
			<PostboxReaderSkeleton :with-header="false" />
		</div>
		<!-- Ciphertext or clearsigned text: the security badge IS the readable half
		     (plus the copy / download recovery controls), so it renders where the
		     body would have been rather than inside the trust chip. -->
		<PostboxSecurityBadge
			v-else-if="holdBody"
			:klass="shownSecureClass"
			:message="badgeMessage"
			:sealed="sealedEnabled ? msg.inboundEncryptionInfo : undefined"
			:signature="shownSignature"
			:omits-content="signedView.kind === 'signed' && signedView.omitsContent"
		/>
		<!-- Off-screen bodies of a long thread wait as a sized placeholder
		     until they scroll near the viewport (plan D8). -->
		<PostboxLazyBody
			v-else
			:message-id="msg._id"
			:force-light="forcedLight"
			:images-allowed="imagesAllowed"
			:eager="eagerBody"
		>
			<PostboxMessageBody
				:message="msg"
				:force-light="forcedLight"
				:sender-images-allowed="imagesAllowed"
				@trackers="emit('trackers', $event)"
				@trust-sender="emit('trust-sender', $event)"
				@untrust-sender="emit('untrust-sender', $event)"
			/>
		</PostboxLazyBody>

		<PostboxInviteCard
			v-if="hasInvite"
			:message-id="msg._id"
			:mailbox-id="mailboxId"
			:own-email="ownEmail"
		/>

		<PostboxMessageAttachments
			:attachments="msg.attachments"
			:message-id="msg._id"
			:downloading-key="downloadingAttachment"
			@preview="(att, all) => emit('preview-attachment', att, all)"
			@download="(att) => emit('download-attachment', att)"
		/>

		<!-- Star / Reply / Reply all / Forward / ⋯. Answer mode drops the row:
		     you are already replying, and the rest stays in the normal reader. -->
		<PostboxReaderMessageActions
			v-if="!reduced"
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
		/>
	</section>
</template>
