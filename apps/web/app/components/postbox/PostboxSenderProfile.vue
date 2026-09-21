<script setup lang="ts">
/**
 * Everything this mailbox knows about one correspondent, as a slide-over from
 * the reader's sender line (plan idea 45).
 *
 * The backend has held VIP, screener state, authentication verdicts and the
 * whole correspondence history per sender for a long time; there was nowhere to
 * see any of it together, and clicking a sender did nothing. This panel is that
 * place: recent threads, shared attachments, the two triage toggles, pinned-key
 * state, one honest line about how their mail authenticates, and a way out into
 * a full `from:` search.
 *
 * Reads are per-surface on purpose rather than one god-query. Each already
 * exists with its own authorization story — the profile and attachment index
 * are mailbox-scoped soft-auth reads, key status is an authed org-member read
 * — and stacking them behind one new endpoint would mean re-deciding all three.
 *
 * Every panel is fail-soft: a read that returns nothing renders nothing, and
 * the panel never invents a fact it did not get an answer for.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { extractEmailAddress } from '~/utils/emailAddress';
import { formatDateTime } from '~/utils/formatters';
import {
	senderAuthLine,
	senderAuthTone,
	senderCountLine,
	senderSearchLink,
} from '~/utils/postboxSenderProfile';

const props = defineProps<{
	open: boolean;
	mailboxId: string;
	/** The From line as displayed; the address is extracted from it. */
	fromAddress: string;
	fromName?: string | null;
}>();

const emit = defineEmits<{ 'update:open': [value: boolean] }>();

const { t } = useI18n();
const { isEnabled: isFeatureEnabled } = useFeatureFlag();

const email = computed(() => extractEmailAddress(props.fromAddress));
// Everything below is skipped while the panel is closed: a reader with twenty
// collapsed messages must not open twenty subscriptions nobody is looking at.
const scope = computed(() =>
	props.open && email.value.includes('@')
		? { mailboxId: props.mailboxId as Id<'mailboxes'>, email: email.value }
		: ('skip' as const)
);

const { data: profile } = useConvexQuery(api.mail.senderProfile.profile, () => scope.value);
const { data: senderState } = useConvexQuery(api.mail.contacts.senderState, () => scope.value);
const { data: files } = useConvexQuery(api.mail.mailbox.attachments.list, () =>
	scope.value === 'skip'
		? ('skip' as const)
		: { mailboxId: scope.value.mailboxId, fromAddress: scope.value.email, limit: 6 }
);
// Pinned-key state is only a fact when Sealed Mail is on; asking otherwise
// would render an empty trust row on every deployment that does not seal.
const { data: keyStatus } = useConvexQuery(api.e2ee.recipientKeys.getRecipientKeyStatus, () =>
	props.open && isFeatureEnabled('sealedMail') && email.value.includes('@')
		? { address: email.value }
		: ('skip' as const)
);

const isVip = computed(() => senderState.value?.isVip === true);
const isScreenerEnabled = computed(() => senderState.value?.isScreenerEnabled === true);
const isScreenerAccepted = computed(
	() => senderState.value?.isScreenerAccepted === true || senderState.value?.isKnown === true
);
const isKeyPinned = computed(
	() => keyStatus.value != null && keyStatus.value.outcome !== 'notFound'
);

const authLine = computed(() =>
	profile.value ? senderAuthLine(profile.value.auth) : { key: '', params: undefined }
);
const authTone = computed(() => (profile.value ? senderAuthTone(profile.value.auth) : 'muted'));
const countLine = computed(() =>
	profile.value
		? senderCountLine(profile.value.messageCount, profile.value.isCountCapped)
		: { key: '', params: undefined }
);
const searchLink = computed(() => senderSearchLink(email.value));

const setVipOp = useBackendOperation(api.mail.contacts.setVip, {
	label: () => t('components.postbox.postboxSenderControls.vipOperation'),
});
const acceptOp = useBackendOperation(api.mail.contacts.acceptSender, {
	label: () => t('components.postbox.postboxSenderControls.acceptOperation'),
});

function toggleVip() {
	void setVipOp.run({
		mailboxId: props.mailboxId as Id<'mailboxes'>,
		email: email.value,
		isVip: !isVip.value,
	});
}

function acceptSender() {
	void acceptOp.run({ mailboxId: props.mailboxId as Id<'mailboxes'>, email: email.value });
}

function close() {
	emit('update:open', false);
}
</script>

<template>
	<Teleport to="body">
		<Transition
			enter-active-class="transition-opacity duration-(--motion-moderate)"
			enter-from-class="opacity-0"
			leave-active-class="transition-opacity duration-(--motion-moderate-exit)"
			leave-to-class="opacity-0"
		>
			<div v-if="open" class="fixed inset-0 z-40 bg-scrim/50" @click="close" />
		</Transition>
		<Transition
			enter-active-class="transition-transform duration-(--motion-moderate)"
			enter-from-class="translate-x-full"
			leave-active-class="transition-transform duration-(--motion-moderate-exit)"
			leave-to-class="translate-x-full"
		>
			<aside
				v-if="open"
				class="fixed top-0 right-0 z-50 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border-subtle bg-bg-elevated"
				role="dialog"
				aria-modal="true"
				:aria-label="t('components.postbox.postboxSenderProfile.title')"
				data-testid="sender-profile"
				@keydown.esc="close"
			>
				<header class="flex items-start gap-3 border-b border-border-subtle p-4">
					<UiAvatar
						:name="fromName ?? profile?.displayName ?? ''"
						:email="email"
						deterministic-color
						size="lg"
						aria-hidden="true"
					/>
					<div class="min-w-0 flex-1">
						<p class="truncate font-medium text-text-primary">
							{{ fromName || profile?.displayName || email }}
						</p>
						<p class="truncate text-xs text-text-tertiary">{{ email }}</p>
						<p class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
							<span
								:class="{
									'text-success': authTone === 'good',
									'text-warning': authTone === 'warn',
									'text-text-tertiary': authTone === 'muted',
								}"
							>
								{{ authLine.key ? t(authLine.key, authLine.params ?? {}) : '' }}
							</span>
							<span v-if="countLine.key" class="text-text-tertiary">
								{{ t(countLine.key, countLine.params ?? {}) }}
							</span>
						</p>
					</div>
					<button
						type="button"
						class="text-text-tertiary hover:text-text-primary"
						:aria-label="t('common.close')"
						@click="close"
					>
						<Icon name="lucide:x" class="h-4 w-4" />
					</button>
				</header>

				<div class="space-y-4 p-4">
					<div class="flex flex-wrap items-center gap-2">
						<UiButton
							size="sm"
							:variant="isVip ? 'primary' : 'outline'"
							type="button"
							:disabled="setVipOp.isLoading.value"
							:aria-pressed="isVip"
							@click="toggleVip"
						>
							<Icon name="lucide:crown" class="mr-1.5 h-3.5 w-3.5" />
							{{
								isVip
									? t('components.postbox.postboxSenderControls.removeVip')
									: t('components.postbox.postboxSenderControls.markVip')
							}}
						</UiButton>
						<!-- Accepting is one-way and only means anything while the screener
						     is on; an already-accepted sender gets a state, not a button. -->
						<UiButton
							v-if="isScreenerEnabled && !isScreenerAccepted"
							size="sm"
							variant="outline"
							type="button"
							:disabled="acceptOp.isLoading.value"
							@click="acceptSender"
						>
							<Icon name="lucide:user-check" class="mr-1.5 h-3.5 w-3.5" />
							{{ t('components.postbox.postboxSenderControls.accept') }}
						</UiButton>
						<span
							v-else-if="isScreenerEnabled"
							class="text-xs text-text-tertiary"
							data-testid="sender-screener-accepted"
						>
							{{ t('components.postbox.postboxSenderProfile.screenerAccepted') }}
						</span>
						<span v-if="isKeyPinned" class="flex items-center gap-1 text-xs text-success">
							<Icon name="lucide:lock" class="h-3.5 w-3.5" />
							{{ t('components.postbox.postboxSenderProfile.keyPinned') }}
						</span>
					</div>

					<section v-if="profile?.threads.length">
						<h3 class="mb-1.5 text-xs font-medium tracking-wide text-text-tertiary uppercase">
							{{ t('components.postbox.postboxSenderProfile.recentThreads') }}
						</h3>
						<ul class="divide-y divide-border-subtle rounded border border-border-subtle">
							<li v-for="thread in profile.threads" :key="thread.messageId">
								<NuxtLink
									:to="`/dashboard/postbox/${thread.folderParam}/${thread.messageId}`"
									class="flex items-baseline gap-2 px-3 py-2 hover:bg-bg-surface"
									@click="close"
								>
									<span
										class="min-w-0 flex-1 truncate text-sm"
										:class="
											thread.isUnread ? 'font-medium text-text-primary' : 'text-text-secondary'
										"
									>
										{{ thread.subject || t('components.postbox.postboxSenderProfile.noSubject') }}
									</span>
									<span class="shrink-0 text-xs text-text-tertiary tabular-nums">
										{{ formatDateTime(thread.receivedAt) }}
									</span>
								</NuxtLink>
							</li>
						</ul>
					</section>

					<section v-if="files?.files.length">
						<h3 class="mb-1.5 text-xs font-medium tracking-wide text-text-tertiary uppercase">
							{{ t('components.postbox.postboxSenderProfile.sharedFiles') }}
						</h3>
						<ul class="divide-y divide-border-subtle rounded border border-border-subtle">
							<li v-for="file in files.files" :key="file._id">
								<NuxtLink
									:to="`/dashboard/postbox/${file.folderParam}/${file.messageId}`"
									class="flex items-center gap-2 px-3 py-2 hover:bg-bg-surface"
									@click="close"
								>
									<Icon name="lucide:paperclip" class="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
									<span class="min-w-0 flex-1 truncate text-sm text-text-secondary">
										{{ file.filename }}
									</span>
								</NuxtLink>
							</li>
						</ul>
					</section>

					<NuxtLink
						:to="searchLink"
						class="flex items-center gap-2 text-sm text-brand hover:underline"
						@click="close"
					>
						<Icon name="lucide:search" class="h-4 w-4" />
						{{ t('components.postbox.postboxSenderProfile.searchAll') }}
					</NuxtLink>
				</div>
			</aside>
		</Transition>
	</Teleport>
</template>
