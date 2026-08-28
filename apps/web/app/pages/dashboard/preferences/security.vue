<script setup lang="ts">
/**
 * Sign-in and security (plan idea 57).
 *
 * The account page has only ever offered a password change, while the auth
 * schema has carried session IP/user-agent and a two-factor table the whole
 * time. This is where those become visible and revocable.
 *
 * Order is deliberate: sessions first, because "is someone else signed in?" is
 * the question a person opens a security page with, and two-factor second,
 * because it is the thing they do about it.
 */
import { useAccountSessions, useTwoFactorEnrolment } from '~/composables/useAccountSecurity';
import type { SecurityFailure } from '~/composables/useAccountSecurity';
import { describeLastSeen, type ActiveSessionRow } from '~/utils/accountSessions';
import {
	backupCodesFilename,
	buildBackupCodesFile,
	groupSecret,
	isCompleteTotpCode,
	normalizeTotpCode,
	parseTotpUri,
	totpQrCode,
} from '~/utils/accountTwoFactor';
import type { LocalizedText } from '~/utils/readinessGate';

const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.preferences.security.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const { user, currentSession, refetch } = useAuth();
const { showToast } = useToast();
const { copy } = useCopyToClipboard();

/** Descriptors from the pure modules are resolved here, at the render boundary. */
function say(text: LocalizedText): string {
	return typeof text === 'string' ? text : t(text.key, text.params ?? {});
}

// ── Sessions ──────────────────────────────────────────────────────────────

const { sessions, otherSessionCount, isLoading, hasLoadError, refresh, revoke, revokeOthers } =
	useAccountSessions(() => currentSession.value?.token ?? null);

onMounted(refresh);

/**
 * A ticking clock, so "3 min ago" does not sit frozen on a page people leave
 * open. One interval for the whole list; the descriptors are pure functions of
 * it, so nothing else has to know that time passed.
 */
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
	clock = setInterval(() => {
		now.value = Date.now();
	}, 30_000);
});
onUnmounted(() => {
	if (clock) clearInterval(clock);
});

function absoluteDate(timestamp: number): string {
	return new Intl.DateTimeFormat(locale.value, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(timestamp);
}

/** Relative inside a week, absolute past it — see `describeLastSeen`. */
function lastSeenLabel(row: ActiveSessionRow): string {
	const relative = describeLastSeen(row.lastSeenAt, now.value);
	return relative ? say(relative) : absoluteDate(row.lastSeenAt);
}

const sessionToRevoke = ref<ActiveSessionRow | null>(null);
const isRevoking = ref(false);

async function confirmRevoke() {
	const target = sessionToRevoke.value;
	if (!target) return;
	isRevoking.value = true;
	try {
		const result = await revoke(target.token);
		if (result.ok) showToast(t('dashboard.preferences.security.sessions.revoked'));
		else showToast(t('dashboard.preferences.security.sessions.revokeFailed'), 'error');
	} finally {
		isRevoking.value = false;
		sessionToRevoke.value = null;
	}
}

const showSignOutOthers = ref(false);
const isSigningOutOthers = ref(false);

async function confirmSignOutOthers() {
	isSigningOutOthers.value = true;
	try {
		const result = await revokeOthers();
		if (result.ok) showToast(t('dashboard.preferences.security.sessions.signedOutOthers'));
		else showToast(t('dashboard.preferences.security.sessions.signOutOthersFailed'), 'error');
	} finally {
		isSigningOutOthers.value = false;
		showSignOutOthers.value = false;
	}
}

// ── Two-factor ────────────────────────────────────────────────────────────

const twoFactor = useTwoFactorEnrolment();

/**
 * `twoFactorEnabled` is contributed to the user row by the two-factor plugin;
 * the Vue client types the session user structurally, so it is read defensively
 * rather than asserted into existence.
 */
const isTwoFactorOn = computed(
	() => (user.value as { twoFactorEnabled?: boolean } | null)?.twoFactorEnabled === true
);

const FAILURE_MESSAGES: Record<SecurityFailure, string> = {
	'wrong-password': 'dashboard.preferences.security.twoFactor.errors.wrongPassword',
	'invalid-code': 'dashboard.preferences.security.twoFactor.errors.invalidCode',
	failed: 'dashboard.preferences.security.twoFactor.errors.failed',
};

/** A blank string means "no error" to `UiInput`, which is what clears the ring. */
function failureMessage(failure: SecurityFailure | null): string {
	return failure ? t(FAILURE_MESSAGES[failure]) : '';
}

/**
 * Enrolment is a three-step dialog, and the middle step is the one that is easy
 * to get wrong: `two-factor/enable` writes an UNVERIFIED secret and leaves the
 * account exactly as it was, and only a confirmed code turns 2FA on. The step
 * names say which of the three is on screen.
 */
type EnrolStep = 'password' | 'save' | 'confirm';
const enrolStep = ref<EnrolStep | null>(null);
const enrolPassword = ref('');
const enrolCode = ref('');
const enrolBusy = ref(false);
const enrolError = ref<SecurityFailure | null>(null);
const totpUri = ref<string | null>(null);
const backupCodes = ref<string[]>([]);

const enrolment = computed(() => parseTotpUri(totpUri.value));
const qr = computed(() => (totpUri.value ? totpQrCode(totpUri.value) : null));
const manualKey = computed(() => (enrolment.value ? groupSecret(enrolment.value.secret) : ''));

function openEnrolment() {
	enrolStep.value = 'password';
	enrolPassword.value = '';
	enrolCode.value = '';
	enrolError.value = null;
	totpUri.value = null;
	backupCodes.value = [];
}

/**
 * The secret and the codes leave memory with the dialog. Nothing on this page
 * needs them once enrolment is finished or abandoned, and an abandoned
 * enrolment's secret is dead anyway — starting again mints a new one.
 */
function closeEnrolment() {
	enrolStep.value = null;
	enrolPassword.value = '';
	enrolCode.value = '';
	totpUri.value = null;
	backupCodes.value = [];
}

async function startEnrolment() {
	if (!enrolPassword.value || enrolBusy.value) return;
	enrolBusy.value = true;
	enrolError.value = null;
	try {
		const result = await twoFactor.begin(enrolPassword.value);
		if (!result.ok) {
			enrolError.value = result.code;
			return;
		}
		totpUri.value = result.data.totpURI;
		backupCodes.value = result.data.backupCodes;
		enrolPassword.value = '';
		enrolStep.value = 'save';
	} finally {
		enrolBusy.value = false;
	}
}

async function confirmEnrolment() {
	if (!isCompleteTotpCode(enrolCode.value) || enrolBusy.value) return;
	enrolBusy.value = true;
	enrolError.value = null;
	try {
		const result = await twoFactor.confirm(enrolCode.value);
		if (!result.ok) {
			enrolError.value = result.code;
			return;
		}
		// Confirming ROTATES the session — BetterAuth issues a new one and deletes
		// the old — so both the cached session and the list above are stale the
		// instant this returns.
		await refetch({ force: true });
		await refresh();
		showToast(t('dashboard.preferences.security.twoFactor.setup.enabled'));
		closeEnrolment();
	} finally {
		enrolBusy.value = false;
	}
}

const showDisable = ref(false);
const disablePassword = ref('');
const disableBusy = ref(false);
const disableError = ref<SecurityFailure | null>(null);

function closeDisable() {
	showDisable.value = false;
	disablePassword.value = '';
	disableError.value = null;
}

async function confirmDisable() {
	if (!disablePassword.value || disableBusy.value) return;
	disableBusy.value = true;
	disableError.value = null;
	try {
		const result = await twoFactor.disable(disablePassword.value);
		if (!result.ok) {
			disableError.value = result.code;
			return;
		}
		await refetch({ force: true });
		showToast(t('dashboard.preferences.security.twoFactor.disableDialog.disabled'));
		closeDisable();
	} finally {
		disableBusy.value = false;
	}
}

const showRegenerate = ref(false);
const regeneratePassword = ref('');
const regenerateBusy = ref(false);
const regenerateError = ref<SecurityFailure | null>(null);

function closeRegenerate() {
	showRegenerate.value = false;
	regeneratePassword.value = '';
	regenerateError.value = null;
}

async function confirmRegenerate() {
	if (!regeneratePassword.value || regenerateBusy.value) return;
	regenerateBusy.value = true;
	regenerateError.value = null;
	try {
		const result = await twoFactor.regenerateBackupCodes(regeneratePassword.value);
		if (!result.ok) {
			regenerateError.value = result.code;
			return;
		}
		// The new codes are shown exactly once — here, as a file. There is no
		// second chance to read them off the server, which keeps only hashes.
		downloadBackupCodes(result.data);
		showToast(t('dashboard.preferences.security.twoFactor.regenerateDialog.done'));
		closeRegenerate();
	} finally {
		regenerateBusy.value = false;
	}
}

/**
 * Write the codes out as a file the user keeps. Every line comes from the
 * catalog, so the document is localised even though its builder is not.
 */
function downloadBackupCodes(codes: readonly string[]) {
	const issuedAt = new Date();
	const contents = buildBackupCodesFile({
		codes,
		heading: t('dashboard.preferences.security.twoFactor.file.heading'),
		accountLine: t('dashboard.preferences.security.twoFactor.file.account', {
			email: user.value?.email ?? '',
		}),
		issuedLine: t('dashboard.preferences.security.twoFactor.file.issued', {
			date: absoluteDate(issuedAt.getTime()),
		}),
		notes: [
			t('dashboard.preferences.security.twoFactor.file.noteOnce'),
			t('dashboard.preferences.security.twoFactor.file.noteReplace'),
			t('dashboard.preferences.security.twoFactor.file.noteStore'),
		],
	});
	const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain;charset=utf-8' }));
	const link = document.createElement('a');
	link.href = url;
	link.setAttribute('download', backupCodesFilename(issuedAt));
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	URL.revokeObjectURL(url);
}

async function copyManualKey() {
	if (!enrolment.value) return;
	const copied = await copy(enrolment.value.secret, 'totp-secret');
	if (copied) showToast(t('dashboard.preferences.security.twoFactor.setup.keyCopied'));
}
</script>

<template>
	<div class="p-6 lg:p-8 max-w-3xl mx-auto">
		<PreferencesBackLink />

		<header class="mb-6">
			<h1 class="text-2xl font-medium tracking-[-0.02em]">
				{{ t('dashboard.preferences.security.heading') }}
			</h1>
			<p class="text-text-secondary mt-1">
				{{ t('dashboard.preferences.security.subheading') }}
			</p>
		</header>

		<!-- ── Active sessions ── -->
		<section class="card !p-0 mb-6">
			<header class="px-5 py-3 border-b border-border-subtle flex items-center justify-between">
				<div>
					<h2 class="font-semibold">
						{{ t('dashboard.preferences.security.sessions.heading') }}
					</h2>
					<p class="text-xs text-text-tertiary mt-0.5">
						{{ t('dashboard.preferences.security.sessions.description') }}
					</p>
				</div>
				<UiButton
					variant="ghost"
					type="button"
					:disabled="otherSessionCount === 0"
					@click="showSignOutOthers = true"
				>
					{{ t('dashboard.preferences.security.sessions.signOutOthers') }}
				</UiButton>
			</header>

			<div v-if="isLoading" class="p-8 flex justify-center">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>
			<p v-else-if="hasLoadError" class="p-8 text-center text-text-secondary">
				{{ t('dashboard.preferences.security.sessions.loadFailed') }}
			</p>
			<p v-else-if="sessions.length === 0" class="p-8 text-center text-text-secondary">
				{{ t('dashboard.preferences.security.sessions.empty') }}
			</p>
			<ul v-else class="divide-y divide-border-subtle">
				<li
					v-for="row in sessions"
					:key="row.id"
					class="px-5 py-3 flex items-center justify-between gap-4"
				>
					<div class="flex items-start gap-3 min-w-0">
						<Icon :name="row.icon" class="w-5 h-5 text-text-tertiary shrink-0 mt-0.5" />
						<div class="min-w-0">
							<p class="font-medium text-sm flex items-center gap-2 flex-wrap">
								<span>{{ say(row.browser) }}</span>
								<span class="text-text-tertiary font-normal">{{ say(row.platform) }}</span>
								<span
									v-if="row.isCurrent"
									class="text-xs px-1.5 py-0.5 rounded bg-success-subtle text-success"
								>
									{{ t('dashboard.preferences.security.sessions.currentBadge') }}
								</span>
							</p>
							<p class="text-xs text-text-tertiary mt-0.5">
								{{
									row.ipAddress
										? t('dashboard.preferences.security.sessions.ipLabel', {
												address: row.ipAddress,
											})
										: t('dashboard.preferences.security.sessions.ipUnknown')
								}}
								·
								{{
									t('dashboard.preferences.security.sessions.lastSeenLabel', {
										when: lastSeenLabel(row),
									})
								}}
							</p>
							<p class="text-xs text-text-tertiary">
								{{
									t('dashboard.preferences.security.sessions.signedInSince', {
										date: absoluteDate(row.createdAt),
									})
								}}
							</p>
						</div>
					</div>
					<UiButton
						v-if="!row.isCurrent"
						variant="ghost"
						type="button"
						class="text-error shrink-0"
						@click="sessionToRevoke = row"
					>
						{{ t('dashboard.preferences.security.sessions.revoke') }}
					</UiButton>
				</li>
			</ul>
		</section>

		<!-- ── Two-factor ── -->
		<section class="card !p-0">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">
					{{ t('dashboard.preferences.security.twoFactor.heading') }}
				</h2>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t('dashboard.preferences.security.twoFactor.description') }}
				</p>
			</header>
			<div class="px-5 py-4 flex items-center justify-between gap-4">
				<div class="min-w-0">
					<p class="font-medium text-sm flex items-center gap-2">
						{{ t('dashboard.preferences.security.twoFactor.authenticatorApp') }}
						<span
							class="text-xs px-1.5 py-0.5 rounded"
							:class="
								isTwoFactorOn
									? 'bg-success-subtle text-success'
									: 'bg-bg-surface text-text-tertiary'
							"
						>
							{{
								isTwoFactorOn
									? t('dashboard.preferences.security.twoFactor.statusOn')
									: t('dashboard.preferences.security.twoFactor.statusOff')
							}}
						</span>
					</p>
					<p class="text-xs text-text-tertiary mt-0.5">
						{{
							isTwoFactorOn
								? t('dashboard.preferences.security.twoFactor.onDetail')
								: t('dashboard.preferences.security.twoFactor.offDetail')
						}}
					</p>
				</div>
				<div class="flex items-center gap-2 shrink-0">
					<template v-if="isTwoFactorOn">
						<UiButton variant="ghost" type="button" @click="showRegenerate = true">
							{{ t('dashboard.preferences.security.twoFactor.regenerate') }}
						</UiButton>
						<UiButton variant="ghost" type="button" class="text-error" @click="showDisable = true">
							{{ t('dashboard.preferences.security.twoFactor.disable') }}
						</UiButton>
					</template>
					<UiButton v-else type="button" @click="openEnrolment">
						{{ t('dashboard.preferences.security.twoFactor.enable') }}
					</UiButton>
				</div>
			</div>
		</section>

		<!-- ── Enrolment ── -->
		<UiModal
			:open="enrolStep !== null"
			size="lg"
			:title="t('dashboard.preferences.security.twoFactor.setup.title')"
			@update:open="(open: boolean) => !open && closeEnrolment()"
		>
			<!-- Step 1: confirm the password that guards the account today. -->
			<form v-if="enrolStep === 'password'" class="space-y-3" @submit.prevent="startEnrolment">
				<p class="text-sm text-text-secondary">
					{{ t('dashboard.preferences.security.twoFactor.setup.passwordStep') }}
				</p>
				<UiInput
					id="twofactor-password"
					v-model="enrolPassword"
					type="password"
					autocomplete="current-password"
					:label="t('dashboard.preferences.security.twoFactor.setup.passwordLabel')"
					:error="failureMessage(enrolError)"
				/>
			</form>

			<!-- Step 2: the secret, both ways, plus the codes that outlive the phone. -->
			<div v-else-if="enrolStep === 'save'" class="space-y-4">
				<div>
					<h3 class="font-medium text-sm">
						{{ t('dashboard.preferences.security.twoFactor.setup.scanTitle') }}
					</h3>
					<div class="mt-2 flex items-start gap-4">
						<!--
							The QR is path DATA, not markup: `totpQrCode` returns one `d`
							string, so the enrolment secret never travels through `v-html`.
							Fixed black-on-white regardless of theme — a camera reads
							contrast, not design tokens.
						-->
						<svg
							v-if="qr"
							class="w-40 h-40 shrink-0 rounded p-1"
							:viewBox="`0 0 ${qr.size} ${qr.size}`"
							role="img"
							:aria-label="t('dashboard.preferences.security.twoFactor.setup.scanAlt')"
						>
							<rect :width="qr.size" :height="qr.size" fill="#ffffff" />
							<path :d="qr.path" fill="#000000" />
						</svg>
						<div class="min-w-0">
							<p class="text-sm text-text-secondary">
								{{ t('dashboard.preferences.security.twoFactor.setup.manualTitle') }}
							</p>
							<p class="font-mono text-sm mt-1 break-all">{{ manualKey }}</p>
							<p v-if="enrolment?.account" class="text-xs text-text-tertiary mt-1">
								{{
									t('dashboard.preferences.security.twoFactor.setup.manualAccount', {
										account: enrolment.account,
									})
								}}
							</p>
							<UiButton variant="ghost" type="button" class="mt-2" @click="copyManualKey">
								<Icon name="lucide:copy" class="w-4 h-4 mr-1.5" />
								{{ t('dashboard.preferences.security.twoFactor.setup.copyKey') }}
							</UiButton>
						</div>
					</div>
				</div>

				<div class="border-t border-border-subtle pt-4">
					<h3 class="font-medium text-sm">
						{{ t('dashboard.preferences.security.twoFactor.setup.codesTitle') }}
					</h3>
					<p class="text-sm text-text-secondary mt-1">
						{{ t('dashboard.preferences.security.twoFactor.setup.codesBody') }}
					</p>
					<ul class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-sm">
						<li v-for="code in backupCodes" :key="code">{{ code }}</li>
					</ul>
					<UiButton
						variant="ghost"
						type="button"
						class="mt-2"
						@click="downloadBackupCodes(backupCodes)"
					>
						<Icon name="lucide:download" class="w-4 h-4 mr-1.5" />
						{{ t('dashboard.preferences.security.twoFactor.setup.download') }}
					</UiButton>
				</div>
			</div>

			<!-- Step 3: the one that actually turns it on. -->
			<form
				v-else-if="enrolStep === 'confirm'"
				class="space-y-3"
				@submit.prevent="confirmEnrolment"
			>
				<p class="text-sm text-text-secondary">
					{{ t('dashboard.preferences.security.twoFactor.setup.confirmBody') }}
				</p>
				<UiInput
					id="twofactor-code"
					:model-value="enrolCode"
					autocomplete="one-time-code"
					:label="t('dashboard.preferences.security.twoFactor.setup.codeLabel')"
					:error="failureMessage(enrolError)"
					@update:model-value="
						(value: string | number) => (enrolCode = normalizeTotpCode(String(value)))
					"
				/>
			</form>

			<template #footer>
				<UiButton variant="ghost" type="button" @click="closeEnrolment">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton
					v-if="enrolStep === 'password'"
					type="button"
					:loading="enrolBusy"
					:disabled="!enrolPassword"
					@click="startEnrolment"
				>
					{{ t('dashboard.preferences.security.twoFactor.setup.start') }}
				</UiButton>
				<UiButton v-else-if="enrolStep === 'save'" type="button" @click="enrolStep = 'confirm'">
					{{ t('dashboard.preferences.security.twoFactor.setup.savedContinue') }}
				</UiButton>
				<UiButton
					v-else
					type="button"
					:loading="enrolBusy"
					:disabled="!isCompleteTotpCode(enrolCode)"
					@click="confirmEnrolment"
				>
					{{ t('dashboard.preferences.security.twoFactor.setup.confirm') }}
				</UiButton>
			</template>
		</UiModal>

		<!-- ── Turn off ── -->
		<UiModal
			:open="showDisable"
			:title="t('dashboard.preferences.security.twoFactor.disableDialog.title')"
			@update:open="(open: boolean) => !open && closeDisable()"
		>
			<form class="space-y-3" @submit.prevent="confirmDisable">
				<p class="text-sm text-text-secondary">
					{{ t('dashboard.preferences.security.twoFactor.disableDialog.body') }}
				</p>
				<UiInput
					id="twofactor-disable-password"
					v-model="disablePassword"
					type="password"
					autocomplete="current-password"
					:label="t('dashboard.preferences.security.twoFactor.disableDialog.passwordLabel')"
					:error="failureMessage(disableError)"
				/>
			</form>
			<template #footer>
				<UiButton variant="ghost" type="button" @click="closeDisable">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton
					type="button"
					:loading="disableBusy"
					:disabled="!disablePassword"
					@click="confirmDisable"
				>
					{{ t('dashboard.preferences.security.twoFactor.disableDialog.confirm') }}
				</UiButton>
			</template>
		</UiModal>

		<!-- ── New backup codes ── -->
		<UiModal
			:open="showRegenerate"
			:title="t('dashboard.preferences.security.twoFactor.regenerateDialog.title')"
			@update:open="(open: boolean) => !open && closeRegenerate()"
		>
			<form class="space-y-3" @submit.prevent="confirmRegenerate">
				<p class="text-sm text-text-secondary">
					{{ t('dashboard.preferences.security.twoFactor.regenerateDialog.body') }}
				</p>
				<UiInput
					id="twofactor-regenerate-password"
					v-model="regeneratePassword"
					type="password"
					autocomplete="current-password"
					:label="t('dashboard.preferences.security.twoFactor.regenerateDialog.passwordLabel')"
					:error="failureMessage(regenerateError)"
				/>
			</form>
			<template #footer>
				<UiButton variant="ghost" type="button" @click="closeRegenerate">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton
					type="button"
					:loading="regenerateBusy"
					:disabled="!regeneratePassword"
					@click="confirmRegenerate"
				>
					{{ t('dashboard.preferences.security.twoFactor.regenerateDialog.confirm') }}
				</UiButton>
			</template>
		</UiModal>

		<UiConfirmationDialog
			:open="sessionToRevoke !== null"
			variant="danger"
			:title="t('dashboard.preferences.security.sessions.revokeDialogTitle')"
			:description="t('dashboard.preferences.security.sessions.revokeDialogDescription')"
			:confirm-text="t('dashboard.preferences.security.sessions.revokeConfirm')"
			:is-loading="isRevoking"
			@update:open="(open: boolean) => !open && (sessionToRevoke = null)"
			@confirm="confirmRevoke"
		/>

		<UiConfirmationDialog
			:open="showSignOutOthers"
			variant="danger"
			:title="t('dashboard.preferences.security.sessions.signOutOthersDialogTitle')"
			:description="t('dashboard.preferences.security.sessions.signOutOthersDialogDescription')"
			:confirm-text="t('dashboard.preferences.security.sessions.signOutOthersConfirm')"
			:is-loading="isSigningOutOthers"
			@update:open="(open: boolean) => (showSignOutOthers = open)"
			@confirm="confirmSignOutOthers"
		/>
	</div>
</template>
