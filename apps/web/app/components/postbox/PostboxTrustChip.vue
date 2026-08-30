<script setup lang="ts">
/**
 * ONE trust chip per message (plan §05).
 *
 * The sender line used to carry up to five competing indicators — the
 * verified-sender badge, the PGP/S-MIME + sealed-mail security badge, the
 * tracking-pixel shield, the correspondent's sealing-key panel, and the VIP /
 * accept-sender controls. They answer one question between them, so this is the
 * one chip that asks it: quiet green when everything checked out, amber when
 * something wants a look, and a popover that still holds every one of them in
 * full detail.
 *
 * Nothing is derived here — `deriveTrustChip` (pure, unit-tested) owns the tone
 * and the label, and the popover mounts the SAME badge components as before, so
 * their own honesty audits keep covering what they render. Feature flags gate
 * rows INSIDE the popover rather than adding chips beside it.
 *
 * The panel is `v-if`-ed, so a thread with twenty expanded messages subscribes
 * to nothing until one chip is opened.
 */
import type { TrackerDetection } from '@owlat/shared/postboxTrackers';
import type { SecureMessageClass } from '@owlat/shared/secureMessage';
import type { RecipientKeyStatus } from '~/utils/recipientKeyStatus';
import type { SenderAuthInput, SenderHeuristics } from '~/utils/senderAuth';
import type { InboundEncryptionInfo } from '~/utils/sealedMessage';
import type { InboundSignatureInfo } from '~/utils/signatureBadge';
import { deriveTrustChip, TRUST_CHIP_TONE_CLASSES } from '~/utils/postboxTrustChip';

const props = defineProps<{
	mailboxId: string;
	fromAddress: string;
	/** Feature flag `senderAuthBadges` — gates the auth row, not a second chip. */
	authEnabled: boolean;
	auth: SenderAuthInput;
	heuristics?: SenderHeuristics;
	/** Feature flag `sealedMail` — gates the sealed row and the key panel. */
	sealedEnabled: boolean;
	sealed?: InboundEncryptionInfo;
	signature?: InboundSignatureInfo;
	secureClass: SecureMessageClass;
	/** The body the security badge reads its ciphertext / cleartext out of. */
	message: { _id?: string; textBodyInline?: string };
	tracker?: TrackerDetection | null;
	/** False for our own messages — no VIP / accept-sender on ourselves. */
	showSenderControls: boolean;
	/** The correspondent's public sealing-key status, when this sender IS them. */
	sealStatus?: RecipientKeyStatus | null;
	/**
	 * Whether the PGP / S-MIME / sealed detail belongs in this popover. It does
	 * NOT when the badge is standing in for a body the reader had to hide
	 * (ciphertext, clearsigned text): there it renders the readable half plus the
	 * recovery controls in the message flow, and one rendering is the rule.
	 */
	showSecurityDetail: boolean;
}>();

const emit = defineEmits<{
	/** A verification was recorded or withdrawn; the reader should re-read. */
	(e: 'seal-refetch'): void;
}>();

const { t } = useI18n();

const chip = computed(() =>
	deriveTrustChip({
		authEnabled: props.authEnabled,
		auth: props.auth,
		...(props.heuristics ? { heuristics: props.heuristics } : {}),
		sealedEnabled: props.sealedEnabled,
		...(props.sealed ? { sealed: props.sealed } : {}),
		...(props.signature ? { signature: props.signature } : {}),
		secureClass: props.secureClass,
		trackerPixels: props.tracker?.pixelCount ?? 0,
		keyChanged: props.sealStatus?.outcome === 'keyChanged',
	})
);

const toneClasses = computed(() => TRUST_CHIP_TONE_CLASSES[chip.value.tone]);

/** Registry keys in, sentences out — this component is the render boundary. */
const label = computed(() => {
	const summary = chip.value.summary;
	return typeof summary === 'string' ? t(summary) : t(summary.key, summary.params ?? {});
});

const showSecurityBadge = computed(
	() =>
		props.showSecurityDetail &&
		(props.secureClass !== 'none' || (props.sealedEnabled && !!props.sealed) || !!props.signature)
);

const showKeyPanel = computed(
	() => props.sealedEnabled && !!props.sealStatus && props.sealStatus.outcome !== 'notFound'
);

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);

// Outside click (the shared composable owns the listener lifecycle) and Escape
// both dismiss — Escape at the document level, so it works while focus is still
// on the chip trigger rather than inside the panel.
useClickOutside(rootRef, () => {
	if (open.value) open.value = false;
});
const handleEscape = (event: KeyboardEvent) => {
	if (event.key === 'Escape') open.value = false;
};
watch(open, (isOpen) => {
	if (isOpen) document.addEventListener('keydown', handleEscape);
	else document.removeEventListener('keydown', handleEscape);
});
onUnmounted(() => document.removeEventListener('keydown', handleEscape));
</script>

<template>
	<span ref="rootRef" class="relative inline-flex" data-testid="trust-chip">
		<button
			type="button"
			class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
			:class="toneClasses.chip"
			:aria-expanded="open"
			:title="label"
			data-testid="trust-chip-toggle"
			@click="open = !open"
		>
			<Icon :name="chip.icon" class="w-3.5 h-3.5" :class="toneClasses.icon" />
			<span data-testid="trust-chip-summary">{{ label }}</span>
			<Icon
				:name="open ? 'lucide:chevron-up' : 'lucide:chevron-down'"
				class="w-3 h-3 text-text-tertiary"
			/>
		</button>

		<div
			v-if="open"
			class="absolute right-0 top-full mt-1 z-20 w-80 max-h-[26rem] overflow-y-auto rounded border border-border-subtle bg-bg-elevated shadow-lg p-3 text-left"
			role="dialog"
			:aria-label="t('components.postbox.postboxTrustChip.panelLabel')"
			data-testid="trust-chip-panel"
			@keydown.esc.prevent.stop="open = false"
		>
			<!-- Sender authentication (flag `senderAuthBadges`): renders nothing on a
			     legacy row with no verdicts, which is the honest answer. -->
			<PostboxAuthBadge :enabled="authEnabled" :auth="auth" :heuristics="heuristics" />

			<!-- PGP / S-MIME structure, the inbound signature verdict and the sealed
			     record, with the recovery controls for ciphertext we can't open. -->
			<PostboxSecurityBadge
				v-if="showSecurityBadge"
				:klass="secureClass"
				:message="message"
				:sealed="sealedEnabled ? sealed : undefined"
				:signature="signature"
			/>

			<!-- Tracking pixels found in the body. Informational: blocking happens in
			     PostboxMessageBody, this only names what was there. -->
			<section v-if="tracker" class="mt-3" data-testid="trust-chip-trackers">
				<p class="text-xs font-medium text-text-primary flex items-center gap-1.5">
					<Icon name="lucide:shield" class="w-3.5 h-3.5 flex-shrink-0" />
					{{
						t(
							'components.postbox.postboxTrustChip.trackersDetected',
							{ count: tracker.pixelCount },
							tracker.pixelCount
						)
					}}
				</p>
				<p class="mt-1 text-xs text-text-secondary">
					{{ t('components.postbox.postboxTrustChip.trackersExplanation') }}
				</p>
				<template v-if="tracker.trackerHosts.length > 0">
					<p class="mt-2 text-2xs uppercase tracking-wide text-text-tertiary">
						{{ t('components.postbox.postboxTrustChip.trackerHosts') }}
					</p>
					<ul class="mt-1 space-y-0.5">
						<li
							v-for="host in tracker.trackerHosts"
							:key="host"
							class="text-xs font-mono text-text-secondary truncate"
							:title="host"
						>
							{{ host }}
						</li>
					</ul>
				</template>
			</section>

			<!-- The correspondent's sealing key: pinned fingerprint, first seen,
			     source, and the human verification ritual (Sealed Mail E5). -->
			<div v-if="showKeyPanel" class="mt-3">
				<PostboxContactKeyPanel
					:address="fromAddress"
					:status="sealStatus!"
					@verification-changed="emit('seal-refetch')"
				/>
			</div>

			<!-- The two per-sender corrections that used to sit on the sender line. -->
			<div
				v-if="showSenderControls"
				class="mt-3 pt-2 border-t border-border-subtle flex items-center justify-between gap-2"
			>
				<span class="text-xs text-text-tertiary">{{
					t('components.postbox.postboxTrustChip.senderControls')
				}}</span>
				<PostboxSenderControls :mailbox-id="mailboxId" :from-address="fromAddress" />
			</div>
		</div>
	</span>
</template>
