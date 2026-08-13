<script setup lang="ts">
/**
 * The fresh-start setup (piece c3) — the body of the DEFAULT welcome branch.
 *
 * Owlat is its own platform by default (locked decision 5): this is a pure
 * product welcome, never an import prompt. The two-minute setup personalises the
 * mailbox reserved for the member (display name, signature, notification scope)
 * and — ONLY when the instance actually has a sending transport — offers an
 * optional test email to themselves, then drops them into Postbox. Finishing
 * marks `userOnboarding.mailboxReady`; a real test send marks `firstSendDone`
 * server-side (in `mail.drafts.send`, which itself gates the stamp on a
 * transport). When there is no send path yet we show an honest "your admin is
 * still setting up sending" note instead of a check the member can't complete,
 * and the unified onboarding checklist shows `firstSendDone` as BLOCKED rather
 * than merely open. Waiting is no longer open-ended in either place: the backend
 * notifies the member the moment the instance can send (`auth/sendReadyNotices`),
 * and a transport that lands while they are still on this screen turns the note
 * into a visible "sending is ready now".
 *
 * When the member has no mailbox and no way to make one, the same honest
 * next-step surface the Postbox guard uses is shown (reserved / connect an
 * external account / ask an admin) — no dead "go to inbox" into an empty wall.
 */
import { api } from '@owlat/api';
import { POSTBOX_NOTIFY_ABOUT_OPTIONS, type PostboxNotifyAbout } from '~/utils/postboxNotify';

const { t } = useI18n();
const { user } = useAuth();
const userId = computed(() => user.value?.id ?? null);

const { currentMailbox, isLoading: mailboxLoading } = usePostboxMailbox();
const mailbox = computed(() => currentMailbox.value);

// Whether a test send from THIS mailbox would actually leave the instance.
// Wraps the same server-side resolution `mail.drafts.send` gates `firstSendDone`
// on (the mailbox's real transport — MTA for hosted, mail-sync worker for a
// connected external account), so the button and the completion never disagree:
// without a transport the send is silently dropped and never records the step,
// so we must not offer a "completes onboarding" button that can't complete
// anything — we reframe the step as an honest "your admin is still setting up
// sending" note instead. Subscribes via useOrganizationQuery (session-gated) and
// skips until the reserved mailbox has resolved, like the delivery cards do.
const { data: canSendData, isLoading: transportLoading } = useOrganizationQuery(
	api.mail.drafts.canSendFrom,
	() => {
		const mb = mailbox.value;
		return mb ? { mailboxId: mb._id } : undefined;
	}
);
const canSend = computed(() => canSendData.value ?? false);

// Did this member actually SEE the "still setting up sending" state? If they
// did and the transport lands while they're here, the row must not just quietly
// swap to a button — it says so. (A member who arrives after sending already
// works was never blocked and gets the plain button.) The out-of-session case is
// covered server-side by the "you can send now" notice — see
// `auth/sendReadyNotices.ts`.
const sawBlocked = ref(false);
watchEffect(() => {
	if (!transportLoading.value && !canSend.value) sawBlocked.value = true;
});
const justUnblocked = computed(() => sawBlocked.value && canSend.value);

// ── Two-minute setup fields ──
const displayName = ref('');
const signatureText = ref('');
const notifyChoice = ref<PostboxNotifyAbout>('everything');
const seededFromMailbox = ref(false);

// Seed the display name once from server state, without clobbering later edits.
watchEffect(() => {
	const mb = mailbox.value;
	if (mb && !seededFromMailbox.value) {
		displayName.value = mb.displayName ?? user.value?.name ?? '';
		seededFromMailbox.value = true;
	}
});

const { notifyAbout, setNotifyAbout, isLoading: settingsLoading } = usePostboxSettings();
const seededNotify = ref(false);

// Seed the notification choice ONCE, from the RESOLVED settings value. Without
// the guard, a late resolution or any live update of the subscription would
// overwrite the member's in-progress selection mid-setup; seeding before the
// query resolves would lock in the placeholder default.
watchEffect(() => {
	if (seededNotify.value || settingsLoading.value) return;
	notifyChoice.value = notifyAbout.value;
	seededNotify.value = true;
});

// ── Operations ──
const setDisplayNameOp = useBackendOperation(api.mail.mailbox.setDisplayName, {
	label: t('welcome.freshStart.operations.saveDisplayName'),
});
const createSignatureOp = useBackendOperation(api.mail.signatures.create, {
	label: t('welcome.freshStart.operations.saveSignature'),
});
const createDraftOp = useBackendOperation(api.mail.drafts.create, {
	label: t('welcome.freshStart.operations.prepareTestEmail'),
});
const updateDraftOp = useBackendOperation(api.mail.drafts.update, {
	label: t('welcome.freshStart.operations.prepareTestEmail'),
});
const sendDraftOp = useBackendOperation(api.mail.drafts.send, {
	label: t('welcome.freshStart.operations.sendTestEmail'),
});
const completeOp = useBackendOperation(api.auth.userOnboarding.completeFreshStart, {
	label: t('welcome.freshStart.operations.finishSetup'),
});

const testSending = ref(false);
const testSent = ref(false);
const finishing = ref(false);

/** Minimal, safe HTML for a plain-text signature (server re-sanitizes). */
function signatureToHtml(text: string): string {
	const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	return `<p>${escaped.replace(/\n/g, '<br />')}</p>`;
}

/**
 * Optional: email yourself. Only reachable when a transport exists (the button
 * is hidden otherwise). Soft-fails on a TRANSIENT send error — a real transport
 * that hiccups is not a blocker — but a missing transport never gets here, so we
 * never record a completion that didn't happen.
 */
async function sendTestEmail() {
	const mb = mailbox.value;
	if (!mb || testSending.value || !canSend.value) return;
	testSending.value = true;
	try {
		const created = await createDraftOp.run({ mailboxId: mb._id });
		if (!created) return;
		const testBody = t('welcome.freshStart.testEmail.body');
		const updated = await updateDraftOp.run({
			draftId: created.draftId,
			toAddresses: [mb.address],
			subject: t('welcome.freshStart.testEmail.subject'),
			bodyText: testBody,
			bodyHtml: `<p>${testBody}</p>`,
		});
		// Bail if the update failed (error already toasted): sending a
		// recipient-less draft would only produce a second "No recipients" toast.
		if (!updated) return;
		const sent = await sendDraftOp.run({ draftId: created.draftId });
		// send() marks firstSendDone server-side; reflect it locally.
		if (sent) testSent.value = true;
	} finally {
		testSending.value = false;
	}
}

/** Apply the setup and land in Postbox. Each write is best-effort/idempotent. */
async function finishSetup() {
	const mb = mailbox.value;
	if (finishing.value) return;
	finishing.value = true;
	try {
		if (mb) {
			const name = displayName.value.trim();
			if (name !== (mb.displayName ?? '')) {
				await setDisplayNameOp.run({ mailboxId: mb._id, displayName: name });
			}
			const sig = signatureText.value.trim();
			if (sig) {
				await createSignatureOp.run({
					mailboxId: mb._id,
					name: t('welcome.freshStart.defaultSignatureName'),
					html: signatureToHtml(sig),
					isDefault: true,
				});
			}
			if (notifyChoice.value !== notifyAbout.value) {
				await setNotifyAbout(notifyChoice.value);
			}
			if (userId.value) {
				await completeOp.run({ userId: userId.value });
			}
		}
		await navigateTo('/dashboard/postbox');
	} finally {
		finishing.value = false;
	}
}

function skipToInbox() {
	void navigateTo('/dashboard/postbox');
}
</script>

<template>
	<div class="mt-8">
		<!-- Loading the mailbox -->
		<div v-if="mailboxLoading" class="flex items-center justify-center py-12">
			<UiSpinner size="sm" />
		</div>

		<!-- No mailbox → the same honest next-step surface as the Postbox guard. -->
		<div
			v-else-if="!mailbox"
			class="overflow-hidden rounded-xl border border-border-subtle bg-bg-surface/50"
		>
			<PostboxMailboxGuard :mailbox-id="null" :loading="false" />
		</div>

		<!-- Two-minute setup for a member who has a mailbox. -->
		<div v-else class="space-y-6">
			<div class="space-y-5">
				<I18nT
					keypath="welcome.freshStart.sendFrom"
					tag="p"
					scope="global"
					class="text-sm text-text-secondary"
				>
					<template #address>
						<span class="font-medium text-text-primary">{{ mailbox.address }}</span>
					</template>
				</I18nT>

				<!-- Display name -->
				<div>
					<label for="fresh-display-name" class="mb-1.5 block text-sm font-medium">
						{{ t('welcome.freshStart.nameLabel') }}
					</label>
					<input
						id="fresh-display-name"
						v-model="displayName"
						type="text"
						:placeholder="t('welcome.freshStart.namePlaceholder')"
						class="w-full rounded-lg border border-border-default bg-bg-deep px-3 py-2 text-sm"
					/>
					<p class="mt-1 text-xs text-text-tertiary">{{ t('welcome.freshStart.nameHint') }}</p>
				</div>

				<!-- Signature -->
				<div>
					<I18nT
						keypath="welcome.freshStart.signatureLabel"
						tag="label"
						scope="global"
						for="fresh-signature"
						class="mb-1.5 block text-sm font-medium"
					>
						<template #optional>
							<span class="font-normal text-text-tertiary">
								{{ t('welcome.freshStart.optional') }}
							</span>
						</template>
					</I18nT>
					<textarea
						id="fresh-signature"
						v-model="signatureText"
						rows="3"
						:placeholder="t('welcome.freshStart.signaturePlaceholder')"
						class="w-full rounded-lg border border-border-default bg-bg-deep px-3 py-2 text-sm"
					/>
					<p class="mt-1 text-xs text-text-tertiary">{{ t('welcome.freshStart.signatureHint') }}</p>
				</div>

				<!-- Notification preference -->
				<div>
					<label for="fresh-notify" class="mb-1.5 block text-sm font-medium">
						{{ t('welcome.freshStart.notifyLabel') }}
					</label>
					<select
						id="fresh-notify"
						v-model="notifyChoice"
						class="w-full rounded-lg border border-border-default bg-bg-deep px-3 py-2 text-sm"
					>
						<option v-for="opt in POSTBOX_NOTIFY_ABOUT_OPTIONS" :key="opt.value" :value="opt.value">
							{{ opt.label }}
						</option>
					</select>
					<p class="mt-1 text-xs text-text-tertiary">{{ t('welcome.freshStart.notifyHint') }}</p>
				</div>

				<!-- Optional test email — only an honest option when a transport exists. -->
				<div class="border-t border-border-subtle pt-4">
					<!-- Loading the transport state: hold the row so it never flashes
					     between the button and the "still setting up" note. -->
					<div v-if="transportLoading" class="flex items-center gap-3">
						<UiSpinner size="sm" />
						<p class="text-xs text-text-tertiary">
							{{ t('welcome.freshStart.checkingTransport') }}
						</p>
					</div>

					<!-- A real transport exists: offer the completable test send. -->
					<div v-else-if="canSend" class="flex items-center justify-between gap-4">
						<div class="min-w-0">
							<p class="text-sm font-medium" :class="justUnblocked ? 'text-success' : ''">
								{{
									justUnblocked
										? t('welcome.freshStart.readyNowTitle')
										: t('welcome.freshStart.testTitle')
								}}
							</p>
							<p class="mt-0.5 text-xs text-text-tertiary">
								{{
									justUnblocked
										? t('welcome.freshStart.readyNowBody')
										: t('welcome.freshStart.testBody')
								}}
							</p>
						</div>
						<UiButton
							v-if="!testSent"
							variant="outline"
							size="sm"
							:loading="testSending"
							@click="sendTestEmail"
						>
							{{ t('welcome.freshStart.emailMyself') }}
						</UiButton>
						<span
							v-else
							class="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-success"
						>
							<Icon name="lucide:check-circle-2" class="h-4 w-4" />
							{{ t('welcome.freshStart.sent') }}
						</span>
					</div>

					<!-- No transport yet: an honest, informational note — NOT a check the
					     member can complete. Sending isn't wired up, so we don't pretend
					     a test would land anywhere. -->
					<div v-else class="flex items-start gap-3">
						<Icon name="lucide:clock" class="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
						<div class="min-w-0">
							<p class="text-sm font-medium">{{ t('welcome.freshStart.blockedTitle') }}</p>
							<p class="mt-0.5 text-xs text-text-tertiary">
								{{ t('welcome.freshStart.blockedBody') }}
							</p>
						</div>
					</div>
				</div>
			</div>

			<!-- Teach-the-product: what Postbox gives you as mail arrives. -->
			<div class="rounded-xl border border-border-subtle bg-bg-surface/50 p-5">
				<h2 class="mb-3 text-sm font-semibold">{{ t('welcome.freshStart.tipsHeading') }}</h2>
				<ul class="space-y-3 text-sm text-text-secondary">
					<li class="flex items-start gap-3">
						<Icon name="lucide:pen-line" class="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
						<I18nT keypath="welcome.freshStart.tips.compose" tag="span" scope="global">
							<template #key>
								<kbd
									class="px-1 py-0.5 bg-bg-elevated border border-border-subtle rounded text-[10px] font-mono"
									>C</kbd
								>
							</template>
						</I18nT>
					</li>
					<li class="flex items-start gap-3">
						<Icon name="lucide:command" class="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
						<I18nT keypath="welcome.freshStart.tips.command" tag="span" scope="global">
							<template #keys>
								<kbd
									class="px-1 py-0.5 bg-bg-elevated border border-border-subtle rounded text-[10px] font-mono"
									>⌘</kbd
								><kbd
									class="px-1 py-0.5 bg-bg-elevated border border-border-subtle rounded text-[10px] font-mono"
									>K</kbd
								>
							</template>
						</I18nT>
					</li>
					<li class="flex items-start gap-3">
						<Icon name="lucide:sparkles" class="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
						<I18nT keypath="welcome.freshStart.tips.knowledge" tag="span" scope="global">
							<template #tab>
								<span class="font-medium text-text-primary">Knowledge</span>
							</template>
						</I18nT>
					</li>
				</ul>
			</div>

			<div class="flex items-center justify-between">
				<button
					type="button"
					class="text-sm text-text-tertiary transition-colors hover:text-text-secondary"
					@click="skipToInbox"
				>
					{{ t('welcome.freshStart.skip') }}
				</button>
				<UiButton :loading="finishing" @click="finishSetup">
					{{ t('welcome.freshStart.finish') }}
				</UiButton>
			</div>
		</div>
	</div>
</template>
