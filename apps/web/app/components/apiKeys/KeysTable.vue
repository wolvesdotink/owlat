<script setup lang="ts">
import type { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import { formatCompactRelativeTime, formatDate, formatDateTime } from '~/utils/formatters';

defineProps<{
	apiKeys: FunctionReturnType<typeof api.auth.apiKeys.listByTeam>;
	activeKeysCount: number;
	canManage: boolean;
	/** The key whose label is being edited inline, if any. */
	renamingId: Id<'apiKeys'> | null;
}>();

/** The inline rename's draft; the page owns it and saves it. */
const renameDraft = defineModel<string>('renameDraft', { required: true });

const emit = defineEmits<{
	startRename: [id: Id<'apiKeys'>, name: string];
	saveRename: [];
	cancelRename: [];
	revoke: [id: Id<'apiKeys'>, name: string];
	delete: [id: Id<'apiKeys'>, name: string];
}>();

const { t } = useI18n();
</script>

<template>
	<div class="card p-0 overflow-hidden">
		<div class="px-6 py-4 border-b border-border-subtle">
			<h2 class="text-sm font-medium text-text-primary">
				{{ t('dashboard.admin.team.api.index.activeKeyCount', activeKeysCount) }}
			</h2>
		</div>
		<div class="overflow-x-auto">
			<table class="w-full">
				<thead>
					<tr class="border-b border-border-subtle">
						<th
							class="text-left px-4 py-3 first:pl-6 text-sm font-medium text-text-secondary whitespace-nowrap"
						>
							{{ t('common.name') }}
						</th>
						<th
							class="text-left px-4 py-3 first:pl-6 text-sm font-medium text-text-secondary whitespace-nowrap"
						>
							{{ t('dashboard.admin.team.api.index.table.key') }}
						</th>
						<th
							class="text-left px-4 py-3 first:pl-6 text-sm font-medium text-text-secondary whitespace-nowrap"
						>
							{{ t('common.status') }}
						</th>
						<th
							class="text-left px-4 py-3 first:pl-6 text-sm font-medium text-text-secondary whitespace-nowrap"
						>
							{{ t('dashboard.admin.team.api.index.table.lastUsed') }}
						</th>
						<th
							class="text-left px-4 py-3 first:pl-6 text-sm font-medium text-text-secondary whitespace-nowrap"
						>
							{{ t('dashboard.admin.team.api.index.table.created') }}
						</th>
						<th
							class="text-right px-4 py-3 pr-6 text-sm font-medium text-text-secondary whitespace-nowrap"
						>
							{{ t('common.actions') }}
						</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="key in apiKeys"
						:key="key._id"
						:class="[
							'border-b border-border-subtle last:border-b-0',
							key.isActive ? 'hover:bg-bg-surface' : 'opacity-60 bg-bg-surface/50',
						]"
					>
						<td class="min-w-32 py-4 pl-6 pr-4">
							<div v-if="renamingId === key._id" class="flex items-center gap-1">
								<input
									v-model="renameDraft"
									class="input input-sm"
									:aria-label="t('dashboard.admin.team.api.index.form.nameAriaLabel')"
									@keyup.enter="emit('saveRename')"
									@keyup.esc="emit('cancelRename')"
								/>
								<UiTooltip :text="t('common.save')">
									<button
										class="p-1 text-success hover:bg-success/10 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
										:aria-label="t('common.save')"
										@click="emit('saveRename')"
									>
										<Icon name="lucide:check" class="w-4 h-4" />
									</button>
								</UiTooltip>
								<UiTooltip :text="t('common.cancel')">
									<button
										class="p-1 text-text-tertiary hover:bg-bg-surface-hover rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
										:aria-label="t('common.cancel')"
										@click="emit('cancelRename')"
									>
										<Icon name="lucide:x" class="w-4 h-4" />
									</button>
								</UiTooltip>
							</div>
							<span v-else class="text-text-primary font-medium">{{ key.name }}</span>
						</td>
						<td class="px-4 py-4 whitespace-nowrap">
							<code class="px-2 py-1 rounded bg-bg-surface text-text-secondary text-sm font-mono">
								{{ key.keyPrefix }}...
							</code>
						</td>
						<td class="px-4 py-4 whitespace-nowrap">
							<span
								v-if="key.isActive"
								class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-success/10 text-success"
							>
								<Icon name="lucide:check" class="w-3 h-3" />
								{{ t('common.active') }}
							</span>
							<span
								v-else
								class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-error/10 text-error"
							>
								<Icon name="lucide:x" class="w-3 h-3" />
								{{ t('dashboard.admin.team.api.index.status.revoked') }}
							</span>
						</td>
						<td class="px-4 py-4 whitespace-nowrap">
							<span
								v-if="key.lastUsedAt"
								class="text-text-secondary text-sm flex items-center gap-1.5"
								:title="formatDateTime(key.lastUsedAt)"
							>
								<Icon name="lucide:clock" class="w-3.5 h-3.5 text-text-tertiary" />
								{{ formatCompactRelativeTime(key.lastUsedAt) }}
							</span>
							<span v-else class="text-text-tertiary text-sm">{{
								t('dashboard.admin.team.api.index.neverUsed')
							}}</span>
						</td>
						<td class="px-4 py-4 whitespace-nowrap">
							<span class="text-text-tertiary text-sm">{{ formatDate(key.createdAt) }}</span>
						</td>
						<td class="py-4 pl-4 pr-6">
							<div class="flex items-center justify-end gap-1">
								<UiTooltip
									v-if="canManage && renamingId !== key._id"
									:text="t('dashboard.admin.team.api.index.actions.rename')"
								>
									<button
										class="p-2 rounded-lg text-text-tertiary hover:text-brand hover:bg-brand/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
										:aria-label="t('dashboard.admin.team.api.index.actions.rename')"
										@click="emit('startRename', key._id, key.name)"
									>
										<Icon name="lucide:pencil" class="w-4 h-4" />
									</button>
								</UiTooltip>
								<UiTooltip
									v-if="key.isActive"
									:text="t('dashboard.admin.team.api.index.actions.revoke')"
								>
									<button
										class="p-2 rounded-lg text-text-tertiary hover:text-warning hover:bg-warning/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
										:aria-label="t('dashboard.admin.team.api.index.actions.revoke')"
										@click="emit('revoke', key._id, key.name)"
									>
										<Icon name="lucide:eye-off" class="w-4 h-4" />
									</button>
								</UiTooltip>
								<UiTooltip :text="t('dashboard.admin.team.api.index.actions.delete')">
									<button
										class="p-2 rounded-lg text-text-tertiary hover:text-error hover:bg-error/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
										:aria-label="t('dashboard.admin.team.api.index.actions.delete')"
										@click="emit('delete', key._id, key.name)"
									>
										<Icon name="lucide:trash-2" class="w-4 h-4" />
									</button>
								</UiTooltip>
							</div>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
	</div>
</template>
