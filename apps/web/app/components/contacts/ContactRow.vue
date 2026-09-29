<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { ContextMenuItem } from '@owlat/ui/components/ui/ContextMenu.vue';

/**
 * One row of the audience contacts table.
 *
 * Its own component so a checkbox click re-renders one row, not the table: the
 * page passes `selected` as a plain boolean, so only the row whose value flips
 * gets new props. The right-click menu is built by a getter that
 * `UiContextMenu` calls when the menu opens, so no row allocates a menu array
 * on render (the page used to build one per row on every selection change).
 */
const props = defineProps<{
	contact: {
		_id: Id<'contacts'>;
		email?: string;
		firstName?: string | null;
		lastName?: string | null;
		createdAt: number;
	};
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

async function copyEmail(email: string) {
	try {
		await navigator.clipboard.writeText(email);
		showToast(t('dashboard.audience.contacts.index.toasts.emailCopied'), 'success');
	} catch {
		showToast(t('dashboard.audience.contacts.index.toasts.copyFailed'), 'error');
	}
}

// Right-click row menu: the row's existing affordances (open + select) plus a
// native copy. No new mutation path: one action source, two entry points.
function menuItems(): ContextMenuItem[] {
	const email = props.contact.email;
	const items: ContextMenuItem[] = [
		{
			id: 'open',
			label: t('dashboard.audience.contacts.index.contextMenu.open'),
			icon: 'lucide:arrow-right',
			run: () => emit('open'),
		},
		{
			id: 'copy-email',
			label: t('dashboard.audience.contacts.index.contextMenu.copyEmail'),
			icon: 'lucide:copy',
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
			icon: props.selected ? 'lucide:square' : 'lucide:check-square',
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
			@click="emit('open')"
			@contextmenu="onContextmenu"
			@keydown="onKeydown"
		>
			<td v-if="canManage" class="w-12 px-4 py-4">
				<button
					class="w-5 h-5 rounded border flex items-center justify-center transition-colors"
					:class="[
						selected
							? 'bg-brand border-brand text-text-inverse'
							: 'border-border-default hover:border-border-strong',
					]"
					@click.stop="emit('toggle-select')"
					:aria-label="
						selected
							? t('dashboard.audience.contacts.index.deselectContact', { email: contact.email })
							: t('dashboard.audience.contacts.index.selectContact', { email: contact.email })
					"
				>
					<Icon v-if="selected" name="lucide:check" class="w-3 h-3" />
				</button>
			</td>
			<td class="px-6 py-4">
				<span class="text-text-primary font-medium">{{ contact.email }}</span>
			</td>
			<td class="px-6 py-4">
				<span class="text-text-secondary">{{ contact.firstName || '-' }}</span>
			</td>
			<td class="px-6 py-4">
				<span class="text-text-secondary">{{ contact.lastName || '-' }}</span>
			</td>
			<td class="px-6 py-4">
				<span class="text-text-tertiary text-sm">{{ formatDate(contact.createdAt) }}</span>
			</td>
		</tr>
	</UiContextMenu>
</template>
