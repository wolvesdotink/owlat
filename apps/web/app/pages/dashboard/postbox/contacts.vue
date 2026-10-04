<script setup lang="ts">
import { postboxPageTransition } from '~/utils/postboxPageTransition';
/**
 * Personal address book for the current mailbox (api.mail.contacts). This is
 * NOT the org-wide Customers store under /dashboard/audience — that is a
 * different dataset owned by the team. These entries feed recipient
 * autocomplete, so this page is the only surface that can correct or remove a
 * stale one; the postbox rail and the command palette both link here.
 */
import type { Id } from '@owlat/api/dataModel';
import { useDebouncedSearch } from '~/composables/useDebouncedSearch';
import { usePostboxHostedVirtualList } from '~/composables/postbox/usePostboxHostedVirtualList';
import { POSTBOX_VIRTUAL_THRESHOLD } from '~/utils/postboxDensity';

const { t } = useI18n();

useHead({ title: () => t('dashboard.postbox.contacts.pageTitle') });
definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', postboxPageTransition],
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
	contacts,
	isLoading,
	error: listError,
	refetch: refetchList,
	save,
	remove,
} = usePostboxContacts(mailboxId);
type MailContact = (typeof contacts.value)[number];
const composeNav = usePostboxComposeNav();
const { showToast } = useToast();

// The filter runs on a short debounce: a fast typist re-filtering (and
// re-rendering) the whole book on every keystroke is the lag this avoids.
const { query: search, debouncedQuery } = useDebouncedSearch(100);
const filtered = computed(() => {
	const q = debouncedQuery.value.trim().toLowerCase();
	if (!q) return contacts.value;
	return contacts.value.filter(
		(c) =>
			c.email.toLowerCase().includes(q) ||
			(c.displayName ?? '').toLowerCase().includes(q) ||
			(c.organization ?? '').toLowerCase().includes(q)
	);
});

// Up to 500 contacts: past the Postbox windowing threshold only the rows near
// the viewport mount. Rows are a fixed 64px (h-16), and the list scrolls with
// the page, so the window follows the page's scroller.
const CONTACT_ROW_HEIGHT = 64;
const listEl = ref<HTMLElement | null>(null);
const virtualize = computed(() => filtered.value.length > POSTBOX_VIRTUAL_THRESHOLD);
const { range } = usePostboxHostedVirtualList({
	listEl,
	itemCount: computed(() => filtered.value.length),
	rowHeight: computed(() => CONTACT_ROW_HEIGHT),
	enabled: virtualize,
});
const visibleContacts = computed(() =>
	filtered.value.slice(range.value.startIndex, range.value.endIndex)
);
// Spacers stand in for the rows outside the window, so the list keeps its full
// height and the scrollbar stays honest.
const listPadding = computed(() =>
	virtualize.value
		? {
				paddingTop: `${range.value.offsetY}px`,
				paddingBottom: `${(filtered.value.length - range.value.endIndex) * CONTACT_ROW_HEIGHT}px`,
			}
		: undefined
);

interface EditForm {
	contactId: Id<'mailContacts'> | null;
	email: string;
	displayName: string;
	organization: string;
}
const editOpen = ref(false);
const form = ref<EditForm>({ contactId: null, email: '', displayName: '', organization: '' });

function openNew() {
	form.value = { contactId: null, email: '', displayName: '', organization: '' };
	editOpen.value = true;
}
function openEdit(c: MailContact) {
	form.value = {
		contactId: c._id,
		email: c.email,
		displayName: c.displayName ?? '',
		organization: c.organization ?? '',
	};
	editOpen.value = true;
}

const canSave = computed(() => form.value.email.trim().includes('@'));

async function submit() {
	if (!canSave.value) return;
	const result = await save({
		email: form.value.email.trim(),
		displayName: form.value.displayName.trim() || undefined,
		organization: form.value.organization.trim() || undefined,
	});
	if (result.ok) editOpen.value = false;
}

// Removing a contact is no longer silent: it confirms with a toast that offers
// an immediate Undo, which re-adds the contact from the captured details.
async function removeContact(c: MailContact) {
	const result = await remove(c._id);
	if (!result.ok) return;
	showToast(
		t('dashboard.postbox.contacts.removedToast', { contact: c.displayName || c.email }),
		'success',
		{
			action: {
				label: t('dashboard.postbox.contacts.undo'),
				onAction: () => {
					void save({
						email: c.email,
						displayName: c.displayName,
						organization: c.organization,
					});
				},
			},
		}
	);
}

function composeTo(email: string) {
	if (!mailboxId.value) return;
	void composeNav.open({ mailboxId: mailboxId.value, prefillTo: [email] });
}

function initial(c: { displayName?: string; email: string }) {
	return (c.displayName || c.email).charAt(0).toUpperCase();
}
</script>

<template>
	<div class="p-6 max-w-3xl mx-auto">
		<!-- Wraps: on a phone the button took a line of its own instead of
		     squeezing the title and wrapping its own label. -->
		<header class="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
			<div class="min-w-0 flex-[1_1_16rem]">
				<h1 class="text-xl font-semibold text-text-primary">
					{{ t('dashboard.postbox.contacts.title') }}
				</h1>
				<p class="text-sm text-text-secondary">{{ t('dashboard.postbox.contacts.subtitle') }}</p>
			</div>
			<UiButton type="button" @click="openNew">
				<template #iconLeft><Icon name="lucide:user-plus" class="w-4 h-4" /></template>
				{{ t('dashboard.postbox.contacts.addContact') }}
			</UiButton>
		</header>

		<div class="relative mb-4">
			<Icon
				name="lucide:search"
				class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
			/>
			<input
				v-model="search"
				type="text"
				:placeholder="t('dashboard.postbox.contacts.searchPlaceholder')"
				class="input w-full pl-9"
			/>
		</div>

		<PostboxMailboxGuard
			:mailbox-id="mailboxId"
			:loading="mailboxesLoading"
			:error="mailboxesError"
			@retry="refetchMailboxes"
		>
			<div v-if="isLoading" class="flex justify-center py-12">
				<Icon
					name="lucide:loader-2"
					class="w-6 h-6 animate-spin motion-reduce:animate-none text-text-tertiary"
				/>
			</div>
			<!-- A failed read is not an empty address book (#721). -->
			<UiQueryBoundary v-else-if="listError" :error="listError" @retry="refetchList" />
			<div v-else-if="filtered.length === 0" class="text-center py-12">
				<Icon name="lucide:users" class="w-10 h-10 mx-auto text-text-tertiary" />
				<p class="text-sm text-text-secondary mt-3">
					{{
						debouncedQuery
							? t('dashboard.postbox.contacts.noMatches')
							: t('dashboard.postbox.contacts.empty')
					}}
				</p>
			</div>
			<ul
				v-else
				ref="listEl"
				class="divide-y divide-border-subtle border border-border-subtle rounded-lg overflow-hidden"
				:style="listPadding"
			>
				<li
					v-for="c in visibleContacts"
					:key="c._id"
					class="group flex items-center gap-3 h-16 px-4 hover:bg-bg-surface"
					style="content-visibility: auto; contain-intrinsic-size: auto 64px"
				>
					<div
						class="w-9 h-9 rounded-full bg-brand-subtle text-brand flex items-center justify-center font-semibold flex-shrink-0"
					>
						{{ initial(c) }}
					</div>
					<div class="flex-1 min-w-0">
						<p class="text-sm font-medium text-text-primary truncate">
							{{ c.displayName || c.email }}
						</p>
						<p class="text-xs text-text-tertiary truncate">
							{{ c.email }}<span v-if="c.organization"> · {{ c.organization }}</span>
						</p>
					</div>
					<!-- Row actions stay reachable for keyboard and touch users: they
					     only fade in on hover, never leave the tab order. -->
					<div
						class="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100"
					>
						<UiButton
							variant="ghost"
							size="sm"
							type="button"
							:title="t('dashboard.postbox.contacts.compose')"
							:aria-label="t('dashboard.postbox.contacts.composeAria')"
							@click="composeTo(c.email)"
						>
							<Icon name="lucide:pencil" class="w-4 h-4" />
						</UiButton>
						<UiButton
							variant="ghost"
							size="sm"
							type="button"
							:title="t('common.edit')"
							:aria-label="t('dashboard.postbox.contacts.editAria')"
							@click="openEdit(c)"
						>
							<Icon name="lucide:edit-2" class="w-4 h-4" />
						</UiButton>
						<UiButton
							variant="danger-ghost"
							size="sm"
							type="button"
							:title="t('common.remove')"
							:aria-label="t('dashboard.postbox.contacts.removeAria')"
							@click="removeContact(c)"
						>
							<Icon name="lucide:trash" class="w-4 h-4" />
						</UiButton>
					</div>
				</li>
			</ul>
		</PostboxMailboxGuard>

		<UiModal
			:open="editOpen"
			:title="
				form.contactId
					? t('dashboard.postbox.contacts.editContact')
					: t('dashboard.postbox.contacts.addContact')
			"
			size="sm"
			@update:open="
				(v) => {
					if (!v) editOpen = false;
				}
			"
		>
			<form class="space-y-3" @submit.prevent="submit">
				<div>
					<label for="form-email" class="text-xs font-medium text-text-tertiary block mb-1">
						{{ t('common.email') }}
					</label>
					<input
						id="form-email"
						v-model="form.email"
						type="email"
						required
						class="input w-full"
						:placeholder="t('dashboard.postbox.contacts.emailPlaceholder')"
					/>
				</div>
				<div>
					<label for="form-displayname" class="text-xs font-medium text-text-tertiary block mb-1">
						{{ t('common.name') }}
					</label>
					<input
						id="form-displayname"
						v-model="form.displayName"
						type="text"
						class="input w-full"
						:placeholder="t('dashboard.postbox.contacts.namePlaceholder')"
					/>
				</div>
				<div>
					<label for="form-organization" class="text-xs font-medium text-text-tertiary block mb-1">
						{{ t('dashboard.postbox.contacts.organization') }}
					</label>
					<input
						id="form-organization"
						v-model="form.organization"
						type="text"
						class="input w-full"
						:placeholder="t('dashboard.postbox.contacts.organizationPlaceholder')"
					/>
				</div>
				<div class="flex justify-end gap-2 pt-1">
					<UiButton variant="ghost" type="button" @click="editOpen = false">
						{{ t('common.cancel') }}
					</UiButton>
					<UiButton type="submit" :disabled="!canSave">{{ t('common.save') }}</UiButton>
				</div>
			</form>
		</UiModal>

	</div>
</template>
