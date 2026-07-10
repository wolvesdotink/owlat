<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Snippets — Owlat' });

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
		<NuxtLink
			to="/dashboard/postbox/settings"
			class="text-sm text-text-secondary inline-flex items-center gap-1 hover:text-text-primary mb-4"
		>
			<Icon name="lucide:arrow-left" class="w-3.5 h-3.5" />
			Back to settings
		</NuxtLink>

		<header class="mb-6 flex items-center justify-between">
			<div>
				<h1 class="text-2xl font-semibold">Snippets</h1>
				<p class="text-text-secondary mt-1">
					Canned responses you can drop into a message. In the composer, type
					<code>/</code> at the start of a line to pick one. Use
					<code v-text="firstNamePlaceholder" /> to greet the recipient by name.
				</p>
			</div>
			<button
				v-if="mailboxId && !editor"
				type="button"
				class="btn btn-primary"
				@click="startCreate"
			>
				<Icon name="lucide:plus" class="w-4 h-4 mr-1.5" />
				New snippet
			</button>
		</header>

		<section v-if="editor" class="card p-5 mb-6 space-y-3">
			<div class="flex gap-3">
				<input
					v-model="editor.name"
					type="text"
					class="input flex-1"
					placeholder="Snippet name (e.g. Thanks)"
				/>
				<input v-model="editor.shortcut" type="text" class="input w-40" placeholder="shortcut" />
			</div>
			<PostboxBasicEditor
				v-model="editor.bodyHtml"
				placeholder="Hi {{firstName}}, thanks for reaching out…"
			/>
			<div class="flex items-center justify-end gap-2">
				<button type="button" class="btn btn-ghost" @click="editor = null">Cancel</button>
				<button type="button" class="btn btn-primary" :disabled="!editor.name.trim()" @click="save">
					{{ editor.id ? 'Save changes' : 'Create' }}
				</button>
			</div>
		</section>

		<section v-if="mailboxId" class="card !p-0">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">Your snippets</h2>
			</header>
			<div v-if="isLoading" class="p-8 flex justify-center">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>
			<div v-else-if="snippets.length === 0" class="p-8 text-center text-text-secondary">
				No snippets yet.
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
					<button type="button" class="btn btn-ghost" @click="startEdit(s)">Edit</button>
					<button type="button" class="btn btn-ghost text-error" @click="snippetToRemove = s._id">
						Delete
					</button>
				</li>
			</ul>
		</section>

		<div v-if="!mailboxId && !mailboxesLoading" class="card p-6 text-center text-text-secondary">
			No mailbox configured.
		</div>

		<UiConfirmationDialog
			:open="!!snippetToRemove"
			variant="danger"
			title="Delete snippet?"
			description="This snippet will be removed. This action cannot be undone."
			confirm-text="Delete snippet"
			:is-loading="isRemoving"
			@update:open="(v: boolean) => !v && (snippetToRemove = null)"
			@confirm="confirmRemove"
		/>
	</div>
</template>
