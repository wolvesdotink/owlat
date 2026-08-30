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
import { usePostboxOriginalEml } from '~/composables/postbox/usePostboxOriginalEml';
import type { SecureMessageClass } from '@owlat/shared/secureMessage';
import type { TrackerDetection } from '@owlat/shared/postboxTrackers';
import type { OutboundDelivery } from '~/utils/postboxDeliveryStrip';
import type { RecipientKeyStatus } from '~/utils/recipientKeyStatus';
import type { PostboxReaderMessage } from './PostboxThreadReader.vue';
import type { PostboxAttachmentMeta } from './PostboxMessageAttachments.vue';

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
	(e: 'preview-attachment', att: PostboxAttachmentMeta, all: PostboxAttachmentMeta[]): void;
	(e: 'download-attachment', att: PostboxAttachmentMeta): void;
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

const authInput = computed<SenderAuthInput>(() => senderAuthInputOf(msg.value));

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

const starLabel = computed(() =>
	props.starred
		? t('components.postbox.postboxThreadReader.unstar')
		: t('components.postbox.postboxThreadReader.star')
);

const renderToggleLabel = computed(() =>
	props.forcedLight
		? t('components.postbox.postboxThreadReader.renderDark')
		: t('components.postbox.postboxThreadReader.renderLight')
);

// The ⋯ item and the details disclosure both hand back the original `.eml`; one
// implementation so they cannot disagree about it.
const { downloading: downloadingEml, downloadOriginal } = usePostboxOriginalEml();

const MENU_ITEM_CLASS =
	'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-bg-surface disabled:opacity-60';
</script>

<template>
	<!-- Collapsed message header -->
	<button
		v-if="!expanded"
		type="button"
		class="w-full flex items-center gap-3 px-3 py-2 rounded border border-border-subtle bg-bg-surface text-left hover:bg-bg-elevated"
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
		class="pbx-reader-message border border-border-subtle rounded bg-bg-surface px-4 py-3"
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
				<div class="flex items-baseline justify-between gap-3">
					<!-- Plan idea 45: the sender line was a text label. It now opens
					     everything this mailbox knows about the person. -->
					<button
						type="button"
						class="text-left hover:underline"
						:title="t('components.postbox.postboxSenderProfile.open')"
						@click="emit('open-sender-profile')"
					>
						<span class="font-medium text-text-primary">
							{{ msg.fromName || msg.fromAddress }}
						</span>
						<span v-if="msg.fromName" class="text-text-tertiary text-sm">
							&lt;{{ msg.fromAddress }}&gt;
						</span>
					</button>
					<div class="flex items-center gap-2 flex-shrink-0">
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
							:signature="msg.inboundSignatureInfo"
							:secure-class="secureClass"
							:message="msg"
							:tracker="tracker"
							:show-sender-controls="showSenderControls"
							:seal-status="sealStatus"
							:show-security-detail="!hideBody"
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
				<p class="text-text-secondary text-xs mt-0.5">
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
				<PostboxUnsubscribeChip
					v-if="msg.unsubscribe"
					class="mt-1.5"
					:message-id="msg._id"
					:mailbox-id="mailboxId"
					:unsubscribe="msg.unsubscribe"
				/>
				<!-- The badge's claims, made checkable: the real headers behind them,
				     the original .eml (UX plan idea 52) — and, in the slot, the three
				     message-scoped details that used to be permanent chrome. -->
				<PostboxMessageDetails :message-id="msg._id">
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

		<!-- Ciphertext or clearsigned text: the security badge IS the readable half
		     (plus the copy / download recovery controls), so it renders where the
		     body would have been rather than inside the trust chip. -->
		<PostboxSecurityBadge
			v-if="hideBody"
			:klass="secureClass"
			:message="msg"
			:sealed="sealedEnabled ? msg.inboundEncryptionInfo : undefined"
			:signature="msg.inboundSignatureInfo"
		/>
		<PostboxMessageBody
			v-else
			:message="msg"
			:force-light="forcedLight"
			:sender-images-allowed="imagesAllowed"
			@trackers="emit('trackers', $event)"
			@trust-sender="emit('trust-sender', $event)"
			@untrust-sender="emit('untrust-sender', $event)"
		/>

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

		<!-- Progressive disclosure: star + reply stay visible; reply-all and
		     forward reveal on row hover in compact density (pointer) and are
		     pinned open everywhere hover never fires. The ⋯ holds what is left
		     once the duplicates are gone. -->
		<div class="mt-4 flex items-center gap-2">
			<UiButton
				variant="ghost"
				type="button"
				:class="starred ? 'text-warning' : 'text-text-tertiary'"
				:title="starLabel"
				:aria-label="starLabel"
				:aria-pressed="starred"
				@click="emit('toggle-star')"
			>
				<Icon name="lucide:star" class="w-4 h-4" :class="{ 'fill-current': starred }" />
			</UiButton>
			<UiButton variant="ghost" type="button" @click="emit('reply')">
				<Icon name="lucide:reply" class="w-4 h-4 mr-1.5" />
				{{ t('components.postbox.postboxThreadReader.reply') }}
			</UiButton>
			<UiButton
				v-if="showReplyAll"
				variant="ghost"
				type="button"
				class="pbx-reader-secondary-action"
				@click="emit('reply-all')"
			>
				<Icon name="lucide:reply-all" class="w-4 h-4 mr-1.5" />
				{{ t('components.postbox.postboxThreadReader.replyAll') }}
			</UiButton>
			<UiButton
				variant="ghost"
				type="button"
				class="pbx-reader-secondary-action"
				@click="emit('forward')"
			>
				<Icon name="lucide:forward" class="w-4 h-4 mr-1.5" />
				{{ t('components.postbox.postboxThreadReader.forward') }}
			</UiButton>
			<span class="flex-1" />
			<PostboxOverflowMenu :label="t('components.postbox.postboxThreadReader.moreActions')">
				<template #default="{ close }">
					<button
						type="button"
						role="menuitem"
						:class="MENU_ITEM_CLASS"
						@click="
							emit('report-spam');
							close();
						"
					>
						<Icon name="lucide:shield-alert" class="w-4 h-4 text-text-tertiary" />
						{{ t('components.postbox.postboxThreadReader.reportSpam') }}
					</button>
					<button
						type="button"
						role="menuitem"
						:class="MENU_ITEM_CLASS"
						@click="
							emit('block-sender');
							close();
						"
					>
						<Icon name="lucide:ban" class="w-4 h-4 text-text-tertiary" />
						{{ t('components.postbox.postboxThreadReader.blockSender') }}
					</button>
					<!-- "One more of these" is where a filter gets written, so the rule
					     builder opens from the message, pre-filled with it. -->
					<button
						type="button"
						role="menuitem"
						:class="MENU_ITEM_CLASS"
						@click="
							emit('create-filter');
							close();
						"
					>
						<Icon name="lucide:filter" class="w-4 h-4 text-text-tertiary" />
						{{ t('components.postbox.postboxThreadReader.createFilter') }}
					</button>
					<button
						type="button"
						role="menuitem"
						:class="MENU_ITEM_CLASS"
						@click="
							emit('print');
							close();
						"
					>
						<Icon name="lucide:printer" class="w-4 h-4 text-text-tertiary" />
						{{ t('components.postbox.postboxThreadReader.print') }}
					</button>
					<button
						type="button"
						role="menuitem"
						:class="MENU_ITEM_CLASS"
						:disabled="downloadingEml"
						@click="downloadOriginal(msg._id)"
					>
						<Icon
							:name="downloadingEml ? 'lucide:loader-2' : 'lucide:download'"
							class="w-4 h-4 text-text-tertiary"
							:class="{ 'animate-spin motion-reduce:animate-none': downloadingEml }"
						/>
						{{ t('components.postbox.postboxMessageDetails.download') }}
					</button>
				</template>
			</PostboxOverflowMenu>
		</div>
	</section>
</template>
