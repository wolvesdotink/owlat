<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { PlusIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.signatures.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const {
	currentMailbox,
	isLoading: mailboxesLoading,
	error: mailboxesError,
	refetch: refetchMailboxes,
} = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

const {
	signatures,
	isLoading,
	error: listError,
	refetch: refetchList,
	create,
	update,
	remove,
} = usePostboxSignatures(mailboxId);

// Sanitized once per list change. In the template it ran for every signature on
// every render, and the editor below re-renders the page on each keystroke.
const safeHtmlById = computed(
	() => new Map(signatures.value.map((s) => [s._id, sanitizePostboxHtml(s.html)]))
);

interface Editor {
	id: Id<'mailSignatures'> | null;
	name: string;
	html: string;
	isDefault: boolean;
}

const editor = ref<Editor | null>(null);
const saving = ref(false);

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
	if (!editor.value || !mailboxId.value || saving.value) return;
	const trimmed = editor.value.name.trim();
	if (!trimmed) return;
	saving.value = true;
	try {
		if (editor.value.id) {
			const result = await update(editor.value.id, {
				name: trimmed,
				html: editor.value.html,
				isDefault: editor.value.isDefault,
			});
			// A refused save keeps the editor and the edits in it, as for create.
			if (!result.ok) return;
		} else {
			const result = await create(trimmed, editor.value.html, editor.value.isDefault);
			// A refused create keeps the editor and what was typed in it; the
			// operation has already said why.
			if (!result.ok) return;
		}
		editor.value = null;
	} finally {
		saving.value = false;
	}
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
		<header
			class="mb-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
		>
			<p class="text-text-secondary">
				{{ t('dashboard.preferences.signatures.intro') }}
			</p>
			<UiButton v-if="mailboxId && !editor" type="button" class="shrink-0" @click="startCreate">
				<PlusIcon class="w-4 h-4 mr-1.5" />
				{{ t('dashboard.preferences.signatures.newSignature') }}
			</UiButton>
		</header>

		<section v-if="editor" class="card p-5 mb-6 space-y-3">
			<div>
				<label for="signature-name" class="label">{{ t('common.name') }}</label>
				<input
					id="signature-name"
					v-model="editor.name"
					type="text"
					class="input w-full"
					:placeholder="t('dashboard.preferences.signatures.namePlaceholder')"
				/>
			</div>
			<PostboxBasicEditor
				v-model="editor.html"
				:placeholder="t('dashboard.preferences.signatures.bodyPlaceholder')"
			/>
			<UiCheckbox
				v-model="editor.isDefault"
				:label="t('dashboard.preferences.signatures.useAsDefault')"
			/>
			<div class="flex items-center justify-end gap-2">
				<UiButton variant="ghost" type="button" :disabled="saving" @click="editor = null">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton type="button" :disabled="!editor.name.trim()" :loading="saving" @click="save">
					{{ editor.id ? t('dashboard.preferences.signatures.saveChanges') : t('common.create') }}
				</UiButton>
			</div>
		</section>

		<section v-if="mailboxId" class="card !p-0">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">{{ t('dashboard.preferences.signatures.yourSignatures') }}</h2>
			</header>
			<div v-if="isLoading" class="p-8 flex justify-center">
				<SpinnerIcon class="w-5 h-5 text-text-tertiary" />
			</div>
			<!-- A failed read is not an empty list. -->
			<UiQueryBoundary v-else-if="listError" :error="listError" @retry="refetchList" />
			<div v-else-if="signatures.length === 0" class="p-8 text-center text-text-secondary">
				{{ t('dashboard.preferences.signatures.empty') }}
			</div>
			<ul v-else class="divide-y divide-border-subtle">
				<li
					v-for="s in signatures"
					:key="s._id"
					class="px-5 py-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2"
				>
					<!-- The actions wrap below the name on a phone instead of
					     squeezing it to a few letters. -->
					<div class="min-w-0 flex-[1_1_14rem]">
						<div class="flex flex-wrap items-center gap-2">
							<span class="font-medium break-words">{{ s.name }}</span>
							<UiBadge v-if="s.isDefault">{{ t('common.default') }}</UiBadge>
						</div>
						<!-- rendered outside the reader iframe → sanitize the stored HTML -->
						<div
							class="text-xs text-text-tertiary mt-1 line-clamp-2"
							v-html="safeHtmlById.get(s._id)"
						/>
					</div>
					<div class="flex flex-wrap items-center gap-1 shrink-0">
						<UiButton
							v-if="!s.isDefault"
							variant="ghost"
							size="sm"
							type="button"
							@click="makeDefault(s._id)"
						>
							{{ t('dashboard.preferences.signatures.makeDefault') }}
						</UiButton>
						<UiButton
							variant="ghost"
							size="sm"
							type="button"
							:aria-label="`${t('common.edit')}: ${s.name}`"
							@click="startEdit(s)"
						>
							{{ t('common.edit') }}
						</UiButton>
						<UiButton
							variant="danger-ghost"
							size="sm"
							type="button"
							:aria-label="`${t('common.delete')}: ${s.name}`"
							@click="signatureToRemove = s._id"
						>
							{{ t('common.delete') }}
						</UiButton>
					</div>
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
