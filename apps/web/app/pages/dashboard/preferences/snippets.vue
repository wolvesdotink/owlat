<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.snippets.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

// literal token shown in copy; kept out of the template to avoid a `}}` mustache clash
const firstNamePlaceholder = '{{firstName}}';

const { snippets, isLoading, create, update, remove } = usePostboxSnippets(mailboxId);

interface Editor {
	id: Id<'mailSnippets'> | null;
	name: string;
	shortcut: string;
	bodyHtml: string;
}

const editor = ref<Editor | null>(null);

function startCreate() {
	editor.value = { id: null, name: '', shortcut: '', bodyHtml: '' };
}

function startEdit(s: (typeof snippets.value)[number]) {
	editor.value = {
		id: s._id,
		name: s.name,
		shortcut: s.shortcut,
		bodyHtml: s.bodyHtml,
	};
}

async function save() {
	if (!editor.value || !mailboxId.value) return;
	const name = editor.value.name.trim();
	if (!name) return;
	const shortcut = editor.value.shortcut.trim();
	if (editor.value.id) {
		await update(editor.value.id, {
			name,
			shortcut,
			bodyHtml: editor.value.bodyHtml,
		});
	} else {
		await create(name, shortcut, editor.value.bodyHtml);
	}
	editor.value = null;
}

const snippetToRemove = ref<Id<'mailSnippets'> | null>(null);
const isRemoving = ref(false);

async function confirmRemove() {
	const id = snippetToRemove.value;
	if (!id) return;
	isRemoving.value = true;
	try {
		await remove(id);
	} finally {
		isRemoving.value = false;
		snippetToRemove.value = null;
	}
}
</script>

<template>
	<div class="p-6 lg:p-8 max-w-3xl mx-auto">
		<PreferencesBackLink />

		<header class="mb-6 flex items-center justify-between">
			<div>
				<h1 class="text-2xl font-medium tracking-[-0.02em]">
					{{ t('dashboard.preferences.snippets.title') }}
				</h1>
				<I18nT
					keypath="dashboard.preferences.snippets.intro"
					tag="p"
					class="text-text-secondary mt-1"
					scope="global"
				>
					<template #slashKey><code>/</code></template>
					<template #firstNameToken><code v-text="firstNamePlaceholder" /></template>
				</I18nT>
			</div>
			<UiButton v-if="mailboxId && !editor" type="button" @click="startCreate">
				<Icon name="lucide:plus" class="w-4 h-4 mr-1.5" />
				{{ t('dashboard.preferences.snippets.newSnippet') }}
			</UiButton>
		</header>

		<section v-if="editor" class="card p-5 mb-6 space-y-3">
			<div class="flex gap-3">
				<input
					v-model="editor.name"
					type="text"
					class="input flex-1"
					:placeholder="t('dashboard.preferences.snippets.namePlaceholder')"
				/>
				<input
					v-model="editor.shortcut"
					type="text"
					class="input w-40"
					:placeholder="t('dashboard.preferences.snippets.shortcutPlaceholder')"
				/>
			</div>
			<PostboxBasicEditor
				v-model="editor.bodyHtml"
				:placeholder="
					t('dashboard.preferences.snippets.bodyPlaceholder', { firstName: firstNamePlaceholder })
				"
			/>
			<div class="flex items-center justify-end gap-2">
				<UiButton variant="ghost" type="button" @click="editor = null">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton type="button" :disabled="!editor.name.trim()" @click="save">
					{{ editor.id ? t('dashboard.preferences.snippets.saveChanges') : t('common.create') }}
				</UiButton>
			</div>
		</section>

		<section v-if="mailboxId" class="card !p-0">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">{{ t('dashboard.preferences.snippets.yourSnippets') }}</h2>
			</header>
			<div v-if="isLoading" class="p-8 flex justify-center">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>
			<div v-else-if="snippets.length === 0" class="p-8 text-center text-text-secondary">
				{{ t('dashboard.preferences.snippets.empty') }}
			</div>
			<ul v-else class="divide-y divide-border-subtle">
				<li
					v-for="s in snippets"
					:key="s._id"
					class="px-5 py-3 flex items-center justify-between gap-3"
				>
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<span class="font-medium">{{ s.name }}</span>
							<span
								v-if="s.shortcut"
								class="text-xs px-1.5 py-0.5 rounded bg-bg-surface text-text-tertiary font-mono"
								>/{{ s.shortcut }}</span
							>
						</div>
						<!-- rendered outside the reader iframe → sanitize the stored HTML -->
						<div
							class="text-xs text-text-tertiary mt-1 line-clamp-2"
							v-html="sanitizePostboxHtml(s.bodyHtml)"
						/>
					</div>
					<UiButton variant="ghost" type="button" @click="startEdit(s)">
						{{ t('common.edit') }}
					</UiButton>
					<UiButton
						variant="ghost"
						type="button"
						class="text-error"
						@click="snippetToRemove = s._id"
					>
						{{ t('common.delete') }}
					</UiButton>
				</li>
			</ul>
		</section>

		<div v-if="!mailboxId && !mailboxesLoading" class="card p-6 text-center text-text-secondary">
			{{ t('dashboard.preferences.snippets.noMailbox') }}
		</div>

		<UiConfirmationDialog
			:open="!!snippetToRemove"
			variant="danger"
			:title="t('dashboard.preferences.snippets.deleteTitle')"
			:description="t('dashboard.preferences.snippets.deleteDescription')"
			:confirm-text="t('dashboard.preferences.snippets.deleteConfirm')"
			:is-loading="isRemoving"
			@update:open="(v: boolean) => !v && (snippetToRemove = null)"
			@confirm="confirmRemove"
		/>
	</div>
</template>
