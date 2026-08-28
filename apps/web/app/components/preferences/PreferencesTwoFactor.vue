<script setup lang="ts">
/**
 * The two-factor half of the sign-in and security page (plan idea 57).
 *
 * A component rather than more page, because the two halves share nothing but
 * the screen: sessions read a list and revoke from it, this runs a three-step
 * enrolment with its own dialogs and its own password prompts. The one thing
 * that DOES cross the seam is announced as an event — confirming a TOTP code
 * rotates the session, which invalidates the list the page is showing.
 */
import { useTwoFactorEnrolment } from '~/composables/useAccountSecurity';
import type { SecurityFailure } from '~/composables/useAccountSecurity';
import {
	groupSecret,
	isCompleteTotpCode,
	normalizeTotpCode,
	parseTotpUri,
	totpQrCode,
} from '~/utils/accountTwoFactor';

/** Raised when the session was rotated underneath the page (see `confirmEnrolment`). */
const emit = defineEmits<{ sessionsChanged: [] }>();

const { t } = useI18n();
const { user, refetch } = useAuth();
const { showToast } = useToast();
const { copy } = useCopyToClipboard();
const { downloadBackupCodes } = useBackupCodesDownload();

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
		emit('sessionsChanged');
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

async function copyManualKey() {
	if (!enrolment.value) return;
	const copied = await copy(enrolment.value.secret, 'totp-secret');
	if (copied) showToast(t('dashboard.preferences.security.twoFactor.setup.keyCopied'));
}
</script>

<template>
	<div>
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
	</div>
</template>
