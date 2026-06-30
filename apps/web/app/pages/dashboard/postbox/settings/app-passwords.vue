<script setup lang="ts">
useHead({ title: 'App passwords — Owlat' });

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
		const scopes = (
			['imap', 'smtp'] as const
		).filter((s) => newScopes.value[s]);
		const result = await generate(trimmed, scopes);
		revealPassword.value = result.cleartext;
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
	if (!ts) return 'Never';
	return new Date(ts).toLocaleString();
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
		<NuxtLink
			to="/dashboard/postbox/settings"
			class="text-sm text-text-secondary inline-flex items-center gap-1 hover:text-text-primary mb-4"
		>
			<Icon name="lucide:arrow-left" class="w-3.5 h-3.5" />
			Back to settings
		</NuxtLink>

		<header class="mb-6 flex items-center justify-between">
			<div>
				<h1 class="text-2xl font-semibold">App passwords</h1>
				<p class="text-text-secondary mt-1">
					Generate per-device credentials for native mail clients
					(Apple Mail, Thunderbird, Gmail mobile, …).
				</p>
			</div>
			<button
				v-if="mailboxId"
				type="button"
				class="btn btn-primary"
				@click="showCreate = true"
			>
				<Icon name="lucide:plus" class="w-4 h-4 mr-1.5" />
				Generate
			</button>
		</header>

		<section v-if="mailboxId" class="card !p-0 mb-6">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">Connection settings</h2>
			</header>
			<dl class="px-5 py-4 grid grid-cols-3 gap-y-2 text-sm">
				<dt class="text-text-tertiary">IMAP</dt>
				<dd class="col-span-2 font-mono">{{ imapHost }}:993 (TLS)</dd>
				<dt class="text-text-tertiary">SMTP</dt>
				<dd class="col-span-2 font-mono">{{ smtpHost }}:465 (TLS) / 587 (STARTTLS)</dd>
				<dt class="text-text-tertiary">Username</dt>
				<dd class="col-span-2 font-mono">{{ currentMailbox?.address }}</dd>
				<dt class="text-text-tertiary">Password</dt>
				<dd class="col-span-2 text-text-secondary">
					Use an app password generated below — your dashboard password won't work here.
				</dd>
			</dl>
		</section>

		<section v-if="mailboxId" class="card !p-0">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">Active passwords</h2>
			</header>
			<div v-if="isLoading" class="p-8 flex justify-center">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>
			<div
				v-else-if="passwords.length === 0"
				class="p-8 text-center text-text-secondary"
			>
				No app passwords yet. Click "Generate" to create one.
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
							<span class="text-xs text-text-tertiary font-mono">
								{{ pw.passwordPrefix }}…
							</span>
							<span
								v-if="pw.revokedAt"
								class="text-xs px-1.5 py-0.5 rounded bg-error/10 text-error"
							>Revoked</span>
							<span
								v-for="scope in pw.scopes"
								:key="scope"
								class="text-xs px-1.5 py-0.5 rounded bg-bg-surface text-text-secondary uppercase"
							>{{ scope }}</span>
						</div>
						<p class="text-xs text-text-tertiary mt-0.5">
							Created {{ formatTime(pw.createdAt) }} · Last used {{ formatTime(pw.lastUsedAt) }}
							<span v-if="pw.lastUsedIp"> · {{ pw.lastUsedIp }}</span>
							<span v-if="pw.lastUsedUa"> · {{ pw.lastUsedUa }}</span>
						</p>
					</div>
					<button
						v-if="!pw.revokedAt"
						type="button"
						class="btn btn-ghost text-error"
						@click="passwordToRevoke = pw._id"
					>
						Revoke
					</button>
				</li>
			</ul>
		</section>

		<div v-if="!mailboxId && !mailboxesLoading" class="card p-6 text-center text-text-secondary">
			No mailbox configured.
		</div>

		<!-- Generate dialog -->
		<div
			v-if="showCreate"
			class="fixed inset-0 bg-black/50 flex items-center justify-center z-40"
			@click.self="showCreate = false"
		>
			<form
				class="bg-bg-elevated rounded-md w-full max-w-md p-5 shadow-2xl"
				@submit.prevent="handleCreate"
			>
				<h2 class="text-lg font-semibold mb-3">Generate app password</h2>
				<label for="newlabel" class="text-sm font-medium block mb-1">Label</label>
				<input id="newlabel"
					v-model="newLabel"
					type="text"
					placeholder="iPhone Mail"
					class="input w-full"
					autofocus
				/>
				<fieldset class="mt-3">
					<legend class="text-sm font-medium mb-1">Allowed protocols</legend>
					<label class="flex items-center gap-2 text-sm">
						<input v-model="newScopes.imap" type="checkbox" />
						IMAP (read mail)
					</label>
					<label class="flex items-center gap-2 text-sm mt-1">
						<input v-model="newScopes.smtp" type="checkbox" />
						SMTP submission (send mail)
					</label>
				</fieldset>
				<div class="flex items-center justify-end gap-2 mt-5">
					<button
						type="button"
						class="btn btn-ghost"
						@click="showCreate = false"
					>Cancel</button>
					<button
						type="submit"
						class="btn btn-primary"
						:disabled="!newLabel.trim() || generating"
					>
						<Icon
							v-if="generating"
							name="lucide:loader-2"
							class="w-4 h-4 mr-1.5 animate-spin"
						/>
						{{ generating ? 'Generating…' : 'Generate' }}
					</button>
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
			title="Revoke app password?"
			description="Connected mail clients using this password will be signed out on next reconnect."
			confirm-text="Revoke password"
			:is-loading="isRevoking"
			@update:open="(v: boolean) => !v && (passwordToRevoke = null)"
			@confirm="confirmRevoke"
		/>
	</div>
</template>
