<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { ContextMenuItem } from '@owlat/ui/components/ui/ContextMenu.vue';
import { contactHasEmail, contactPrimaryIdentity } from '~/utils/contactIdentity';
import { ArrowRightIcon, CopyIcon, SquareCheckIcon, SquareIcon } from '@coolicons/vue';

/**
 * One row of the audience contacts table.
 *
 * Its own component so a checkbox click re-renders one row, not the table: the
 * page passes `selected` as a plain boolean, so only the row whose value flips
 * gets new props. The right-click menu is built by a getter that
 * `UiContextMenu` calls when the menu opens, so no row allocates a menu array
 * on render (the page used to build one per row on every selection change).
 *
 * The email is a real link to the contact, so it takes keyboard focus, opens
 * on Enter and honours middle/modified clicks; the rest of the row is a plain
 * mouse target for the same page.
 */
const props = defineProps<{
	contact: {
		_id: Id<'contacts'>;
		email?: string;
		firstName?: string | null;
		lastName?: string | null;
		createdAt: number;
	};
	/** The contact's page; the email cell links here. */
	to: string;
	selected: boolean;
	/** Shows the checkbox column and the menu's select/deselect item. */
	canManage: boolean;
}>();

const emit = defineEmits<{
	open: [];
	'toggle-select': [];
}>();

const { t } = useI18n();
const { showToast } = useToast();

// What the row shows and announces for the contact: its email, else its name,
// else "Unnamed contact". The email is optional, so this is never left blank.
const identity = computed(() => contactPrimaryIdentity(props.contact, t));

async function copyEmail(email: string) {
	try {
		await navigator.clipboard.writeText(email);
		showToast(t('dashboard.audience.contacts.index.toasts.emailCopied'), 'success');
	} catch {
		showToast(t('dashboard.audience.contacts.index.toasts.copyFailed'), 'error');
	}
}

// A click that landed on the link or the checkbox is theirs; a modified or
// non-primary click is the browser's (new tab, new window), not a row open.
function onRowClick(event: MouseEvent) {
	if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
		return;
	}
	if ((event.target as Element | null)?.closest('a, button, label, input')) return;
	emit('open');
}

// Right-click row menu: the row's existing affordances (open + select) plus a
// native copy. No new mutation path: one action source, two entry points.
function menuItems(): ContextMenuItem[] {
	const email = props.contact.email;
	const items: ContextMenuItem[] = [
		{
			id: 'open',
			label: t('dashboard.audience.contacts.index.contextMenu.open'),
			icon: ArrowRightIcon,
			run: () => emit('open'),
		},
		{
			id: 'copy-email',
			label: t('dashboard.audience.contacts.index.contextMenu.copyEmail'),
			icon: CopyIcon,
			disabled: !email,
			run: () => {
				if (email) void copyEmail(email);
			},
		},
	];
	if (props.canManage) {
		items.push({
			id: 'select',
			label: props.selected
				? t('dashboard.audience.contacts.index.contextMenu.deselect')
				: t('dashboard.audience.contacts.index.contextMenu.select'),
			icon: props.selected ? SquareIcon : SquareCheckIcon,
			separatorBefore: true,
			run: () => emit('toggle-select'),
		});
	}
	return items;
}
</script>

<template>
	<UiContextMenu :items="menuItems" v-slot="{ onContextmenu, onKeydown }">
		<tr
			class="border-b border-border-subtle last:border-b-0 hover:bg-bg-surface transition-colors cursor-pointer"
			:class="{ 'bg-brand/5': selected }"
			@click="onRowClick"
			@contextmenu="onContextmenu"
		>
			<td v-if="canManage" class="w-12 px-4 py-4 density-compact:py-2">
				<!-- A real checkbox: its checked state is the selection, so the name
				     stays put. The row's click guard leaves its clicks (and Space) alone. -->
				<UiCheckbox
					:model-value="selected"
					:aria-label="t('dashboard.audience.contacts.index.selectContact', { email: identity })"
					@update:model-value="emit('toggle-select')"
				/>
			</td>
			<td class="px-6 py-4 density-compact:py-2">
				<!-- The row is not focusable, so the menu key listens on its link. -->
				<NuxtLink
					:to="to"
					class="font-medium rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					:class="contactHasEmail(contact) ? 'text-text-primary' : 'text-text-secondary'"
					@keydown="onKeydown"
				>
					{{ identity }}
				</NuxtLink>
				<!-- The cell sits under the "Email" header, so a name or placeholder
				     says, visibly and to a screen reader, that the email is missing. The
				     leading space keeps it a separate word in the cell's text (the template
				     compiler drops whitespace between the two elements). It stays outside
				     the link, whose name is the contact's identity alone. -->
				<span v-if="!contactHasEmail(contact)" class="ml-1 text-xs text-text-tertiary">{{
					` ${t('dashboard.audience.contacts.index.noEmail')}`
				}}</span>
			</td>
			<td class="px-6 py-4 density-compact:py-2">
				<span class="text-text-secondary">{{ contact.firstName || '-' }}</span>
			</td>
			<td class="px-6 py-4 density-compact:py-2">
				<span class="text-text-secondary">{{ contact.lastName || '-' }}</span>
			</td>
			<td class="px-6 py-4 density-compact:py-2">
				<span class="text-text-tertiary text-sm">{{ formatDate(contact.createdAt) }}</span>
			</td>
		</tr>
	</UiContextMenu>
</template>
