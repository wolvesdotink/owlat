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
import { PencilIcon, SearchIcon, TrashIcon, UserPlusCornerIcon, UsersIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

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
	restore,
	resumeCardDav,
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

// Removing a contact confirms with a toast that offers an immediate Undo, which
// puts the whole row back from the copy the page holds: details, source and,
// while the server still keeps it, the picture.
async function removeContact(c: MailContact) {
	const result = await remove(c._id);
	if (!result.ok) return;
	const photoRemovalId = result.result?.photoRemovalId;
	showToast(
		t('dashboard.postbox.contacts.removedToast', { contact: c.displayName || c.email }),
		'success',
		{
			action: {
				label: t('dashboard.postbox.contacts.undo'),
				onAction: () => {
					void restore(c, photoRemovalId);
				},
			},
		}
	);
}

async function resumeCardDavUpdates(c: MailContact) {
	const result = await resumeCardDav(c._id);
	if (!result.ok) return;
	showToast(
		t('dashboard.postbox.contacts.resumedToast', { contact: c.displayName || c.email }),
		'success'
	);
}

function composeTo(email: string) {
	if (!mailboxId.value) return;
	void composeNav.open({ mailboxId: mailboxId.value, prefillTo: [email] });
}

function initial(c: { displayName?: string; email: string }) {
	return (c.displayName || c.email).charAt(0).toUpperCase();
}

const isTeamInbox = computed(() => currentMailbox.value?.scope === 'shared');

// Where a row came from: a CardDAV sync, a vCard import, or mail and the
// add-contact form. A synced row that a vCard import also touched counts as
// synced, since the sync keeps it up to date. A synced row edited here no
// longer follows its card until the person resumes it.
type ContactSource = 'carddav' | 'carddavEdited' | 'vcard' | 'mail';
function sourceOf(c: MailContact): ContactSource {
	if (c.cardDavSource?.editedAt !== undefined && !c.cardDavSource.isRowCreatedBySync) {
		return 'carddavEdited';
	}
	if (c.cardDavSource) return 'carddav';
	if (c.importedAt !== undefined) return 'vcard';
	return 'mail';
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
			<div class="flex flex-wrap items-center gap-2">
				<PostboxContactsVcardActions :mailbox-id="mailboxId" :contacts="contacts" />
				<UiButton type="button" @click="openNew">
					<template #iconLeft><UserPlusCornerIcon class="w-4 h-4" /></template>
					{{ t('dashboard.postbox.contacts.addContact') }}
				</UiButton>
			</div>
		</header>

		<LazyPostboxContactsCardDavPanel :mailbox-id="mailboxId" :is-team-inbox="isTeamInbox" />

		<div class="relative mb-4">
			<SearchIcon class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
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
				<SpinnerIcon class="w-6 h-6 text-text-tertiary" />
			</div>
			<!-- A failed read is not an empty address book. -->
			<UiQueryBoundary v-else-if="listError" :error="listError" @retry="refetchList" />
			<div v-else-if="filtered.length === 0" class="text-center py-12">
				<UsersIcon class="w-10 h-10 mx-auto text-text-tertiary" :stroke-width="1.5" />
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
					<img
						v-if="c.photoUrl"
						:src="c.photoUrl"
						alt=""
						class="w-9 h-9 rounded-full object-cover flex-shrink-0"
						loading="lazy"
					/>
					<div
						v-else
						class="w-9 h-9 rounded-full bg-brand-subtle text-brand flex items-center justify-center font-semibold flex-shrink-0"
					>
						{{ initial(c) }}
					</div>
					<div class="flex-1 min-w-0">
						<p class="flex items-center gap-2 text-sm font-medium text-text-primary">
							<span class="truncate">{{ c.displayName || c.email }}</span>
							<UiTooltip :text="t(`dashboard.postbox.contacts.source.${sourceOf(c)}Tooltip`)">
								<UiBadge variant="neutral" class="flex-shrink-0">
									{{ t(`dashboard.postbox.contacts.source.${sourceOf(c)}`) }}
								</UiBadge>
							</UiTooltip>
						</p>
						<p class="text-xs text-text-tertiary truncate">
							{{ c.email }}<span v-if="c.organization"> · {{ c.organization }}</span
							><span v-if="c.phones?.[0]"> · {{ c.phones[0].value }}</span>
						</p>
					</div>
					<!-- Always shown: it is the only way back to following the card. -->
					<UiButton
						v-if="sourceOf(c) === 'carddavEdited'"
						variant="ghost"
						size="sm"
						type="button"
						class="flex-shrink-0"
						@click="resumeCardDavUpdates(c)"
					>
						{{ t('dashboard.postbox.contacts.resumeCardDav') }}
					</UiButton>
					<!-- Row actions stay reachable for keyboard and touch users: they
					     only fade in on hover, never leave the tab order. -->
					<div
						class="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100"
					>
						<UiTooltip :text="t('dashboard.postbox.contacts.compose')">
							<UiButton
								variant="ghost"
								size="sm"
								type="button"
								:aria-label="t('dashboard.postbox.contacts.composeAria')"
								@click="composeTo(c.email)"
							>
								<PencilIcon class="w-4 h-4" />
							</UiButton>
						</UiTooltip>
						<UiTooltip :text="t('common.edit')">
							<UiButton
								variant="ghost"
								size="sm"
								type="button"
								:aria-label="t('dashboard.postbox.contacts.editAria')"
								@click="openEdit(c)"
							>
								<PencilIcon class="w-4 h-4" />
							</UiButton>
						</UiTooltip>
						<UiTooltip :text="t('common.remove')">
							<UiButton
								variant="danger-ghost"
								size="sm"
								type="button"
								:aria-label="t('dashboard.postbox.contacts.removeAria')"
								@click="removeContact(c)"
							>
								<TrashIcon class="w-4 h-4" />
							</UiButton>
						</UiTooltip>
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
