<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.signatures.pageTitle') });

definePageMeta({
	layout: 'preferences',
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
	<div>
		<header class="mb-6 flex items-center justify-between gap-4">
			<p class="text-text-secondary">
				{{ t('dashboard.preferences.signatures.intro') }}
			</p>
			<UiButton v-if="mailboxId && !editor" type="button" @click="startCreate">
				<Icon name="lucide:plus" class="w-4 h-4 mr-1.5" />
				{{ t('dashboard.preferences.signatures.newSignature') }}
			</UiButton>
		</header>

		<section v-if="editor" class="card p-5 mb-6 space-y-3">
			<input
				v-model="editor.name"
				type="text"
				class="input w-full"
				:placeholder="t('dashboard.preferences.signatures.namePlaceholder')"
			/>
			<PostboxBasicEditor
				v-model="editor.html"
				:placeholder="t('dashboard.preferences.signatures.bodyPlaceholder')"
			/>
			<label class="flex items-center gap-2 text-sm">
				<input v-model="editor.isDefault" type="checkbox" />
				{{ t('dashboard.preferences.signatures.useAsDefault') }}
			</label>
			<div class="flex items-center justify-end gap-2">
				<UiButton variant="ghost" type="button" @click="editor = null">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton type="button" :disabled="!editor.name.trim()" @click="save">
					{{ editor.id ? t('dashboard.preferences.signatures.saveChanges') : t('common.create') }}
				</UiButton>
			</div>
		</section>

		<section v-if="mailboxId" class="card !p-0">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">{{ t('dashboard.preferences.signatures.yourSignatures') }}</h2>
			</header>
			<div v-if="isLoading" class="p-8 flex justify-center">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>
			<div v-else-if="signatures.length === 0" class="p-8 text-center text-text-secondary">
				{{ t('dashboard.preferences.signatures.empty') }}
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
								>{{ t('common.default') }}</span
							>
						</div>
						<!-- rendered outside the reader iframe → sanitize the stored HTML -->
						<div
							class="text-xs text-text-tertiary mt-1 line-clamp-2"
							v-html="sanitizePostboxHtml(s.html)"
						/>
					</div>
					<UiButton variant="ghost" v-if="!s.isDefault" type="button" @click="makeDefault(s._id)">
						{{ t('dashboard.preferences.signatures.makeDefault') }}
					</UiButton>
					<UiButton variant="ghost" type="button" @click="startEdit(s)">
						{{ t('common.edit') }}
					</UiButton>
					<UiButton
						variant="ghost"
						type="button"
						class="text-error"
						@click="signatureToRemove = s._id"
					>
						{{ t('common.delete') }}
					</UiButton>
				</li>
			</ul>
		</section>

		<div v-if="!mailboxId && !mailboxesLoading" class="card p-6 text-center text-text-secondary">
			{{ t('dashboard.preferences.signatures.noMailbox') }}
		</div>

		<UiConfirmationDialog
			:open="!!signatureToRemove"
			variant="danger"
			:title="t('dashboard.preferences.signatures.deleteTitle')"
			:description="t('dashboard.preferences.signatures.deleteDescription')"
			:confirm-text="t('dashboard.preferences.signatures.deleteConfirm')"
			:is-loading="isRemovingSignature"
			@update:open="(v: boolean) => !v && (signatureToRemove = null)"
			@confirm="confirmRemove"
		/>
	</div>
</template>
