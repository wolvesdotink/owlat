<script setup lang="ts">
import { PlusIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.preferences.appPasswords.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const {
	mailboxes,
	currentMailbox,
	isLoading: mailboxesLoading,
	error: mailboxesError,
	refetch: refetchMailboxes,
} = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

const {
	passwords,
	isLoading,
	error: listError,
	refetch: refetchList,
	generate,
	revoke,
} = usePostboxAppPasswords(mailboxId);

const showCreate = ref(false);
const newLabel = ref('');
const newScopes = ref<{ imap: boolean; smtp: boolean }>({ imap: true, smtp: true });
const generating = ref(false);

const revealOpen = ref(false);
const revealPassword = ref<string | null>(null);
const revealLabel = ref<string | null>(null);

async function handleCreate() {
	const trimmed = newLabel.value.trim();
	if (!trimmed) return;
	generating.value = true;
	try {
		const scopes = (['imap', 'smtp'] as const).filter((s) => newScopes.value[s]);
		const result = await generate(trimmed, scopes);
		if (!result.ok) return;
		revealPassword.value = result.result.cleartext;
		revealLabel.value = trimmed;
		revealOpen.value = true;
		newLabel.value = '';
		showCreate.value = false;
	} finally {
		generating.value = false;
	}
}

const passwordToRevoke = ref<import('@owlat/api/dataModel').Id<'mailAppPasswords'> | null>(null);
const isRevoking = ref(false);

async function confirmRevoke() {
	const id = passwordToRevoke.value;
	if (!id) return;
	isRevoking.value = true;
	try {
		await revoke(id);
	} finally {
		isRevoking.value = false;
		passwordToRevoke.value = null;
	}
}

function formatTime(ts?: number) {
	if (!ts) return t('common.never');
	return new Intl.DateTimeFormat(locale.value, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(ts);
}

const imapHost = computed(() => {
	if (import.meta.server) return 'mail.your-domain';
	const slug = window.location.hostname.split('.')[0];
	return `mail.${slug}.owlat.app`;
});
const smtpHost = computed(() => imapHost.value);
</script>

<template>
	<div>
		<header
			class="mb-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
		>
			<p class="text-text-secondary">
				{{ t('dashboard.preferences.appPasswords.subheading') }}
			</p>
			<UiButton v-if="mailboxId" type="button" class="shrink-0" @click="showCreate = true">
				<PlusIcon class="w-4 h-4 mr-1.5" />
				{{ t('dashboard.preferences.appPasswords.generate') }}
			</UiButton>
		</header>

		<section v-if="mailboxId" class="card !p-0 mb-6">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">
					{{ t('dashboard.preferences.appPasswords.connectionSettings') }}
				</h2>
			</header>
			<!-- Label above value on a phone: a mono host name next to a label column
			     does not fit 390px. -->
			<dl
				class="px-5 py-4 grid grid-cols-1 gap-y-0.5 text-sm sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-6 sm:gap-y-2"
			>
				<dt class="text-text-tertiary max-sm:not-first:mt-2">
					{{ t('dashboard.preferences.appPasswords.imapLabel') }}
				</dt>
				<dd class="font-mono break-words">
					{{ t('dashboard.preferences.appPasswords.imapValue', { host: imapHost }) }}
				</dd>
				<dt class="text-text-tertiary max-sm:not-first:mt-2">
					{{ t('dashboard.preferences.appPasswords.smtpLabel') }}
				</dt>
				<dd class="font-mono break-words">
					{{ t('dashboard.preferences.appPasswords.smtpValue', { host: smtpHost }) }}
				</dd>
				<dt class="text-text-tertiary max-sm:not-first:mt-2">
					{{ t('dashboard.preferences.appPasswords.usernameLabel') }}
				</dt>
				<dd class="font-mono break-words">{{ currentMailbox?.address }}</dd>
				<dt class="text-text-tertiary max-sm:not-first:mt-2">
					{{ t('dashboard.preferences.appPasswords.passwordLabel') }}
				</dt>
				<dd class="text-text-secondary">
					{{ t('dashboard.preferences.appPasswords.passwordHint') }}
				</dd>
			</dl>
		</section>

		<section v-if="mailboxId" class="card !p-0">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">{{ t('dashboard.preferences.appPasswords.activePasswords') }}</h2>
			</header>
			<div v-if="isLoading" class="p-8 flex justify-center">
				<SpinnerIcon class="w-5 h-5 text-text-tertiary" />
			</div>
			<!-- A failed read is not an empty list. -->
			<UiQueryBoundary v-else-if="listError" :error="listError" @retry="refetchList" />
			<div v-else-if="passwords.length === 0" class="p-8 text-center text-text-secondary">
				{{ t('dashboard.preferences.appPasswords.empty') }}
			</div>
			<ul v-else class="divide-y divide-border-subtle">
				<li
					v-for="pw in passwords"
					:key="pw._id"
					class="px-5 py-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2"
				>
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-2">
							<span class="font-medium break-words">{{ pw.label }}</span>
							<span class="text-xs text-text-tertiary font-mono">{{ pw.passwordPrefix }}…</span>
							<UiBadge v-if="pw.revokedAt" variant="error">{{
								t('dashboard.preferences.appPasswords.revoked')
							}}</UiBadge>
							<UiBadge
								v-for="scope in pw.scopes"
								:key="scope"
								variant="neutral"
								class="uppercase"
								>{{ scope }}</UiBadge
							>
						</div>
						<p class="text-xs text-text-tertiary mt-0.5 break-words">
							{{
								t('dashboard.preferences.appPasswords.usageLine', {
									created: formatTime(pw.createdAt),
									lastUsed: formatTime(pw.lastUsedAt),
								})
							}}
							<span v-if="pw.lastUsedIp"> · {{ pw.lastUsedIp }}</span>
							<span v-if="pw.lastUsedUa"> · {{ pw.lastUsedUa }}</span>
						</p>
					</div>
					<UiButton
						v-if="!pw.revokedAt"
						variant="danger-ghost"
						type="button"
						class="shrink-0"
						:aria-label="t('dashboard.preferences.appPasswords.revokeNamed', { name: pw.label })"
						@click="passwordToRevoke = pw._id"
					>
						{{ t('dashboard.preferences.appPasswords.revoke') }}
					</UiButton>
				</li>
			</ul>
		</section>

		<UiQueryBoundary
			v-if="!mailboxId && mailboxesError"
			:error="mailboxesError"
			@retry="refetchMailboxes"
		/>
		<div
			v-else-if="!mailboxId && !mailboxesLoading"
			class="card p-6 text-center text-text-secondary"
		>
			{{ t('dashboard.preferences.appPasswords.noMailbox') }}
		</div>

		<UiModal
			:open="showCreate"
			:title="t('dashboard.preferences.appPasswords.generateDialogTitle')"
			size="md"
			:persistent="generating"
			initial-focus="#newlabel"
			@update:open="showCreate = $event"
		>
			<form id="app-password-create-form" class="space-y-5" @submit.prevent="handleCreate">
				<div>
					<label for="newlabel" class="label">{{
						t('dashboard.preferences.appPasswords.labelLabel')
					}}</label>
					<input
						id="newlabel"
						v-model="newLabel"
						type="text"
						:placeholder="t('dashboard.preferences.appPasswords.labelPlaceholder')"
						class="input w-full"
					/>
				</div>
				<fieldset class="space-y-2">
					<legend class="label">
						{{ t('dashboard.preferences.appPasswords.allowedProtocols') }}
					</legend>
					<UiCheckbox
						v-model="newScopes.imap"
						:label="t('dashboard.preferences.appPasswords.scopeImap')"
					/>
					<UiCheckbox
						v-model="newScopes.smtp"
						:label="t('dashboard.preferences.appPasswords.scopeSmtp')"
					/>
				</fieldset>
			</form>
			<template #footer>
				<UiButton variant="ghost" type="button" :disabled="generating" @click="showCreate = false">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton
					type="submit"
					form="app-password-create-form"
					:disabled="!newLabel.trim()"
					:loading="generating"
				>
					{{
						generating
							? t('dashboard.preferences.appPasswords.generating')
							: t('dashboard.preferences.appPasswords.generate')
					}}
				</UiButton>
			</template>
		</UiModal>

		<PostboxAppPasswordReveal
			:open="revealOpen"
			:password="revealPassword"
			:label="revealLabel"
			@update:open="revealOpen = $event"
		/>

		<UiConfirmationDialog
			:open="!!passwordToRevoke"
			variant="danger"
			:title="t('dashboard.preferences.appPasswords.revokeDialogTitle')"
			:description="t('dashboard.preferences.appPasswords.revokeDialogDescription')"
			:confirm-text="t('dashboard.preferences.appPasswords.revokePassword')"
			:is-loading="isRevoking"
			@update:open="(v: boolean) => !v && (passwordToRevoke = null)"
			@confirm="confirmRevoke"
		/>
	</div>
</template>
