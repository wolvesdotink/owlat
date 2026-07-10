<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Signatures — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

const { signatures, isLoading, create, update, remove } = usePostboxSignatures(mailboxId);

interface Editor {
	id: Id<'mailSignatures'> | null;
	name: string;
	html: string;
	isDefault: boolean;
}

const editor = ref<Editor | null>(null);

function startCreate() {
	editor.value = { id: null, name: '', html: '', isDefault: false };
}

function startEdit(s: (typeof signatures.value)[number]) {
	editor.value = {
		id: s._id,
		name: s.name,
		html: s.html,
		isDefault: s.isDefault,
	};
}

async function save() {
	if (!editor.value || !mailboxId.value) return;
	const trimmed = editor.value.name.trim();
	if (!trimmed) return;
	if (editor.value.id) {
		await update(editor.value.id, {
			name: trimmed,
			html: editor.value.html,
			isDefault: editor.value.isDefault,
		});
	} else {
		await create(trimmed, editor.value.html, editor.value.isDefault);
	}
	editor.value = null;
}

const signatureToRemove = ref<Id<'mailSignatures'> | null>(null);
const isRemovingSignature = ref(false);

async function confirmRemove() {
	const id = signatureToRemove.value;
	if (!id) return;
	isRemovingSignature.value = true;
	try {
		await remove(id);
	} finally {
		isRemovingSignature.value = false;
		signatureToRemove.value = null;
	}
}

async function makeDefault(id: Id<'mailSignatures'>) {
	await update(id, { isDefault: true });
}
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
				<h1 class="text-2xl font-semibold">Signatures</h1>
				<p class="text-text-secondary mt-1">
					Default signature is appended to new drafts. Pick a different one per message via the
					composer toolbar.
				</p>
			</div>
			<button
				v-if="mailboxId && !editor"
				type="button"
				class="btn btn-primary"
				@click="startCreate"
			>
				<Icon name="lucide:plus" class="w-4 h-4 mr-1.5" />
				New signature
			</button>
		</header>

		<section v-if="editor" class="card p-5 mb-6 space-y-3">
			<input
				v-model="editor.name"
				type="text"
				class="input w-full"
				placeholder="Signature name (e.g. Work)"
			/>
			<PostboxBasicEditor v-model="editor.html" placeholder="— Marcel" />
			<label class="flex items-center gap-2 text-sm">
				<input v-model="editor.isDefault" type="checkbox" />
				Use as the default signature for new drafts
			</label>
			<div class="flex items-center justify-end gap-2">
				<button type="button" class="btn btn-ghost" @click="editor = null">Cancel</button>
				<button type="button" class="btn btn-primary" :disabled="!editor.name.trim()" @click="save">
					{{ editor.id ? 'Save changes' : 'Create' }}
				</button>
			</div>
		</section>

		<section v-if="mailboxId" class="card !p-0">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">Your signatures</h2>
			</header>
			<div v-if="isLoading" class="p-8 flex justify-center">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>
			<div v-else-if="signatures.length === 0" class="p-8 text-center text-text-secondary">
				No signatures yet.
			</div>
			<ul v-else class="divide-y divide-border-subtle">
				<li
					v-for="s in signatures"
					:key="s._id"
					class="px-5 py-3 flex items-center justify-between gap-3"
				>
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<span class="font-medium">{{ s.name }}</span>
							<span
								v-if="s.isDefault"
								class="text-xs px-1.5 py-0.5 rounded bg-brand-subtle text-brand"
								>Default</span
							>
						</div>
						<!-- rendered outside the reader iframe → sanitize the stored HTML -->
						<div
							class="text-xs text-text-tertiary mt-1 line-clamp-2"
							v-html="sanitizePostboxHtml(s.html)"
						/>
					</div>
					<button
						v-if="!s.isDefault"
						type="button"
						class="btn btn-ghost"
						@click="makeDefault(s._id)"
					>
						Make default
					</button>
					<button type="button" class="btn btn-ghost" @click="startEdit(s)">Edit</button>
					<button type="button" class="btn btn-ghost text-error" @click="signatureToRemove = s._id">
						Delete
					</button>
				</li>
			</ul>
		</section>

		<div v-if="!mailboxId && !mailboxesLoading" class="card p-6 text-center text-text-secondary">
			No mailbox configured.
		</div>

		<UiConfirmationDialog
			:open="!!signatureToRemove"
			variant="danger"
			title="Delete signature?"
			description="This signature will be removed. This action cannot be undone."
			confirm-text="Delete signature"
			:is-loading="isRemovingSignature"
			@update:open="(v: boolean) => !v && (signatureToRemove = null)"
			@confirm="confirmRemove"
		/>
	</div>
</template>
