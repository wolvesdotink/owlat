<script setup lang="ts">
import type { OrganizationMember } from '~/composables/useOrganization';
import { filterRoster } from '~/utils/memberGroups';
import { SearchIcon } from '@coolicons/vue';

/**
 * A searchable checklist of the workspace roster: avatar, name and email per
 * row, checked when the person is picked. `v-model` is the picked user ids.
 */
const props = defineProps<{
	members: OrganizationMember[];
	disabled?: boolean;
}>();

const selected = defineModel<string[]>({ required: true });

const { t } = useI18n();

const search = ref('');
const shown = computed(() => filterRoster(props.members, search.value));
const picked = computed(() => new Set(selected.value));

function toggle(userId: string, on: boolean) {
	if (on === picked.value.has(userId)) return;
	selected.value = on ? [...selected.value, userId] : selected.value.filter((id) => id !== userId);
}

const searchId = useId();
</script>

<template>
	<div class="space-y-2">
		<label :for="searchId" class="sr-only">{{
			t('dashboard.admin.team.groups.picker.search')
		}}</label>
		<UiInput
			:id="searchId"
			v-model="search"
			size="sm"
			:placeholder="t('dashboard.admin.team.groups.picker.searchPlaceholder')"
			:disabled="disabled"
		>
			<template #iconLeft>
				<SearchIcon class="w-4 h-4 text-text-tertiary" />
			</template>
		</UiInput>

		<p
			v-if="shown.length === 0"
			class="px-1 py-3 text-sm text-text-tertiary"
			data-testid="member-picker-empty"
		>
			{{ t('dashboard.admin.team.groups.picker.noMatches', { query: search.trim() }) }}
		</p>
		<ul
			v-else
			class="max-h-64 overflow-y-auto rounded-(--radius-card) border border-border-subtle divide-y divide-border-subtle"
			:aria-label="t('dashboard.admin.team.groups.picker.label')"
		>
			<li v-for="member in shown" :key="member.userId">
				<label
					class="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-bg-surface"
					:class="{ 'opacity-50 cursor-not-allowed': disabled }"
					data-testid="member-picker-row"
				>
					<input
						type="checkbox"
						class="h-4 w-4 shrink-0 rounded border-border-default bg-bg-deep text-brand focus:ring-brand focus:ring-offset-0"
						:checked="picked.has(member.userId)"
						:disabled="disabled"
						:value="member.userId"
						@change="toggle(member.userId, ($event.target as HTMLInputElement).checked)"
					/>
					<UiAvatar
						:name="member.user.name"
						:email="member.user.email"
						:image="member.user.image"
						size="md"
					/>
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm font-medium text-text-primary">
							{{ member.user.name || member.user.email }}
						</span>
						<span v-if="member.user.name" class="block truncate text-xs text-text-tertiary">
							{{ member.user.email }}
						</span>
					</span>
				</label>
			</li>
		</ul>
		<p class="px-1 text-xs text-text-tertiary" aria-live="polite">
			{{
				t(
					'dashboard.admin.team.groups.picker.selected',
					{ count: selected.length },
					selected.length
				)
			}}
		</p>
	</div>
</template>
