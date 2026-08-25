<script setup lang="ts">
const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.preferences.appPasswords.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const { mailboxes, currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

const { passwords, isLoading, generate, revoke } = usePostboxAppPasswords(mailboxId);

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
	if (typeof window === 'undefined') return 'mail.your-domain';
	const slug = window.location.hostname.split('.')[0];
	return `mail.${slug}.owlat.app`;
});
const smtpHost = computed(() => imapHost.value);
</script>

<template>
	<div class="p-6 lg:p-8 max-w-3xl mx-auto">
		<PreferencesBackLink />

		<header class="mb-6 flex items-center justify-between">
			<div>
				<h1 class="text-2xl font-medium tracking-[-0.02em]">
					{{ t('dashboard.preferences.appPasswords.heading') }}
				</h1>
				<p class="text-text-secondary mt-1">
					{{ t('dashboard.preferences.appPasswords.subheading') }}
				</p>
			</div>
			<UiButton v-if="mailboxId" type="button" @click="showCreate = true">
				<Icon name="lucide:plus" class="w-4 h-4 mr-1.5" />
				{{ t('dashboard.preferences.appPasswords.generate') }}
			</UiButton>
		</header>

		<section v-if="mailboxId" class="card !p-0 mb-6">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">
					{{ t('dashboard.preferences.appPasswords.connectionSettings') }}
				</h2>
			</header>
			<dl class="px-5 py-4 grid grid-cols-3 gap-y-2 text-sm">
				<dt class="text-text-tertiary">{{ t('dashboard.preferences.appPasswords.imapLabel') }}</dt>
				<dd class="col-span-2 font-mono">
					{{ t('dashboard.preferences.appPasswords.imapValue', { host: imapHost }) }}
				</dd>
				<dt class="text-text-tertiary">{{ t('dashboard.preferences.appPasswords.smtpLabel') }}</dt>
				<dd class="col-span-2 font-mono">
					{{ t('dashboard.preferences.appPasswords.smtpValue', { host: smtpHost }) }}
				</dd>
				<dt class="text-text-tertiary">
					{{ t('dashboard.preferences.appPasswords.usernameLabel') }}
				</dt>
				<dd class="col-span-2 font-mono">{{ currentMailbox?.address }}</dd>
				<dt class="text-text-tertiary">
					{{ t('dashboard.preferences.appPasswords.passwordLabel') }}
				</dt>
				<dd class="col-span-2 text-text-secondary">
					{{ t('dashboard.preferences.appPasswords.passwordHint') }}
				</dd>
			</dl>
		</section>

		<section v-if="mailboxId" class="card !p-0">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">{{ t('dashboard.preferences.appPasswords.activePasswords') }}</h2>
			</header>
			<div v-if="isLoading" class="p-8 flex justify-center">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>
			<div v-else-if="passwords.length === 0" class="p-8 text-center text-text-secondary">
				{{ t('dashboard.preferences.appPasswords.empty') }}
			</div>
			<ul v-else class="divide-y divide-border-subtle">
				<li
					v-for="pw in passwords"
					:key="pw._id"
					class="px-5 py-3 flex items-center justify-between"
				>
					<div>
						<div class="flex items-center gap-2">
							<span class="font-medium">{{ pw.label }}</span>
							<span class="text-xs text-text-tertiary font-mono"> {{ pw.passwordPrefix }}… </span>
							<span
								v-if="pw.revokedAt"
								class="text-xs px-1.5 py-0.5 rounded bg-error/10 text-error"
								>{{ t('dashboard.preferences.appPasswords.revoked') }}</span
							>
							<span
								v-for="scope in pw.scopes"
								:key="scope"
								class="text-xs px-1.5 py-0.5 rounded bg-bg-surface text-text-secondary uppercase"
								>{{ scope }}</span
							>
						</div>
						<p class="text-xs text-text-tertiary mt-0.5">
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
						variant="ghost"
						v-if="!pw.revokedAt"
						type="button"
						class="text-error"
						@click="passwordToRevoke = pw._id"
					>
						{{ t('dashboard.preferences.appPasswords.revoke') }}
					</UiButton>
				</li>
			</ul>
		</section>

		<div v-if="!mailboxId && !mailboxesLoading" class="card p-6 text-center text-text-secondary">
			{{ t('dashboard.preferences.appPasswords.noMailbox') }}
		</div>

		<!-- Generate dialog -->
		<div
			v-if="showCreate"
			class="fixed inset-0 bg-scrim/50 flex items-center justify-center z-40"
			@click.self="showCreate = false"
		>
			<form
				class="bg-bg-elevated rounded-md w-full max-w-md p-5 shadow-2xl"
				@submit.prevent="handleCreate"
			>
				<h2 class="text-lg font-semibold mb-3">
					{{ t('dashboard.preferences.appPasswords.generateDialogTitle') }}
				</h2>
				<label for="newlabel" class="text-sm font-medium block mb-1">{{
					t('dashboard.preferences.appPasswords.labelLabel')
				}}</label>
				<input
					id="newlabel"
					v-model="newLabel"
					type="text"
					:placeholder="t('dashboard.preferences.appPasswords.labelPlaceholder')"
					class="input w-full"
					autofocus
				/>
				<fieldset class="mt-3">
					<legend class="text-sm font-medium mb-1">
						{{ t('dashboard.preferences.appPasswords.allowedProtocols') }}
					</legend>
					<label class="flex items-center gap-2 text-sm">
						<input v-model="newScopes.imap" type="checkbox" />
						{{ t('dashboard.preferences.appPasswords.scopeImap') }}
					</label>
					<label class="flex items-center gap-2 text-sm mt-1">
						<input v-model="newScopes.smtp" type="checkbox" />
						{{ t('dashboard.preferences.appPasswords.scopeSmtp') }}
					</label>
				</fieldset>
				<div class="flex items-center justify-end gap-2 mt-5">
					<UiButton variant="ghost" type="button" @click="showCreate = false">
						{{ t('common.cancel') }}
					</UiButton>
					<UiButton type="submit" :disabled="!newLabel.trim() || generating">
						<Icon v-if="generating" name="lucide:loader-2" class="w-4 h-4 mr-1.5 animate-spin" />
						{{
							generating
								? t('dashboard.preferences.appPasswords.generating')
								: t('dashboard.preferences.appPasswords.generate')
						}}
					</UiButton>
				</div>
			</form>
		</div>

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
