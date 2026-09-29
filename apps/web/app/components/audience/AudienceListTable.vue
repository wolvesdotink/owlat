<script lang="ts">
interface AudienceListItem {
	_id: string;
	name: string;
	description?: string;
	createdAt: number;
}
</script>

<script setup lang="ts" generic="T extends AudienceListItem, TField extends string">
/**
 * The rows of the segment and topic lists, as a table (`layout="table"`) or as
 * the card list below `md` (`layout="cards"`). `ListPageShell` decides which of
 * the two is mounted; this renders the one it is given, plus the count footer.
 *
 * Each item's name is a link to its detail page, with a visible focus ring,
 * so the list has a keyboard route; the edit and delete buttons carry their
 * own. Segments add their filter column and a "view contacts" link through
 * the `#extra-header` / `#extra-cell` / `#actions` slots.
 */
import { formatDate, formatNumber } from '~/utils/formatters';

const props = defineProps<{
	items: T[];
	layout: 'table' | 'cards';
	/** The glyph beside each name in the table. */
	icon: string;
	itemTo: (item: T) => string;
	/** The member count, or null while it is not known yet. */
	countOf: (item: T) => number | null | undefined;
	/** The sort key of the count column. */
	countField: TField;
	countHeader: string;
	createdHeader: string;
	/** The footer line: how many items the list shows. */
	totalText: string;
	editLabel: string;
	deleteLabel: string;
	canManage: boolean;
	getSortIcon: (field: TField) => string | null;
	/** The card's second line; the description when omitted. */
	subtitleOf?: (item: T) => string | undefined;
}>();

const emit = defineEmits<{
	sort: [field: TField];
	edit: [item: T];
	delete: [item: T];
}>();

defineSlots<{
	'extra-header'?: () => unknown;
	'extra-cell'?: (props: { item: T }) => unknown;
	actions?: (props: { item: T }) => unknown;
}>();

const { t } = useI18n();

// The sortable headers in order; a page's extra column goes after the name.
const sortColumns = computed(() => [
	{ field: 'name' as TField, label: t('common.name') },
	{ field: props.countField, label: props.countHeader },
	{ field: 'createdAt' as TField, label: props.createdHeader },
]);

const countText = (item: T) => {
	const count = props.countOf(item);
	return count == null ? '—' : formatNumber(count);
};
const subtitle = (item: T) => (props.subtitleOf ? props.subtitleOf(item) : item.description);

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';
const headerCell = 'text-left px-6 py-4 text-sm font-medium text-text-secondary';
</script>

<template>
	<div>
		<ul v-if="layout === 'cards'" class="divide-y divide-border-subtle">
			<li v-for="item in items" :key="item._id" class="flex items-center gap-1 px-4 py-2">
				<NuxtLink :to="itemTo(item)" :class="['flex-1 min-w-0 py-1 rounded', focusRing]">
					<span class="block text-text-primary font-medium truncate">{{ item.name }}</span>
					<span v-if="subtitle(item)" class="block text-sm text-text-secondary truncate">
						{{ subtitle(item) }}
					</span>
					<span class="flex items-center gap-1.5 text-xs text-text-tertiary mt-0.5">
						<Icon name="lucide:users" class="w-3.5 h-3.5" />
						{{ countText(item) }}
						<span aria-hidden="true">·</span>
						{{ formatDate(item.createdAt) }}
					</span>
				</NuxtLink>
				<template v-if="canManage">
					<button
						type="button"
						:class="[
							'w-11 h-11 flex items-center justify-center flex-shrink-0 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors',
							focusRing,
						]"
						:title="editLabel"
						:aria-label="editLabel"
						@click="emit('edit', item)"
					>
						<Icon name="lucide:pencil" class="w-4 h-4" />
					</button>
					<button
						type="button"
						:class="[
							'w-11 h-11 flex items-center justify-center flex-shrink-0 rounded-lg text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors',
							focusRing,
						]"
						:title="deleteLabel"
						:aria-label="deleteLabel"
						@click="emit('delete', item)"
					>
						<Icon name="lucide:trash-2" class="w-4 h-4" />
					</button>
				</template>
			</li>
		</ul>

		<div v-else class="overflow-x-auto">
			<table class="w-full">
				<thead>
					<tr class="border-b border-border-subtle">
						<template v-for="(column, index) in sortColumns" :key="column.field">
							<th :class="headerCell">
								<button
									type="button"
									class="flex items-center gap-1 py-4 -my-4 px-1 -mx-1 rounded hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
									@click="emit('sort', column.field)"
								>
									{{ column.label }}
									<Icon
										v-if="getSortIcon(column.field)"
										:name="getSortIcon(column.field)!"
										class="w-4 h-4"
									/>
								</button>
							</th>
							<th v-if="index === 0 && $slots['extra-header']" :class="headerCell">
								<slot name="extra-header" />
							</th>
						</template>
						<th :class="[headerCell, 'text-right']">
							{{ t('common.actions') }}
						</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="item in items"
						:key="item._id"
						class="border-b border-border-subtle last:border-b-0 hover:bg-bg-surface transition-colors"
					>
						<td class="px-6 py-4">
							<NuxtLink
								:to="itemTo(item)"
								:class="['flex items-center gap-3 group rounded', focusRing]"
							>
								<UiIconBox :icon="icon" size="sm" variant="surface" rounded="lg" />
								<div>
									<span
										class="text-text-primary font-medium group-hover:text-brand transition-colors"
										>{{ item.name }}</span
									>
									<p v-if="item.description" class="text-sm text-text-tertiary">
										{{ item.description }}
									</p>
								</div>
							</NuxtLink>
						</td>
						<td v-if="$slots['extra-cell']" class="px-6 py-4">
							<slot name="extra-cell" :item="item" />
						</td>
						<td class="px-6 py-4">
							<div class="flex items-center gap-2">
								<Icon name="lucide:users" class="w-4 h-4 text-text-tertiary" />
								<span class="text-text-secondary tabular-nums">{{ countText(item) }}</span>
							</div>
						</td>
						<td class="px-6 py-4">
							<span class="text-text-tertiary text-sm whitespace-nowrap">{{
								formatDate(item.createdAt)
							}}</span>
						</td>
						<td class="px-6 py-4">
							<div class="flex items-center justify-end gap-1">
								<slot name="actions" :item="item" />
								<template v-if="canManage">
									<button
										type="button"
										:class="[
											'p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors',
											focusRing,
										]"
										:title="editLabel"
										:aria-label="editLabel"
										@click="emit('edit', item)"
									>
										<Icon name="lucide:pencil" class="w-4 h-4" />
									</button>
									<button
										type="button"
										:class="[
											'p-2 rounded-lg text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors',
											focusRing,
										]"
										:title="deleteLabel"
										:aria-label="deleteLabel"
										@click="emit('delete', item)"
									>
										<Icon name="lucide:trash-2" class="w-4 h-4" />
									</button>
								</template>
							</div>
						</td>
					</tr>
				</tbody>
			</table>
		</div>

		<div class="px-6 py-4 border-t border-border-subtle">
			<p class="text-sm text-text-tertiary">{{ totalText }}</p>
		</div>
	</div>
</template>
