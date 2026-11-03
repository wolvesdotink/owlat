<script setup lang="ts">
import type { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import { formatRelativeTime } from '~/utils/formatters';
import { PlusIcon } from '@coolicons/vue';

defineProps<{
	admins: FunctionReturnType<typeof api.platformAdmin.queries.listPlatformAdmins> | undefined;
	/** Someone on the instance does not hold platform admin yet. */
	hasPromotableUsers: boolean;
	/** Any console write is in flight; every action waits for it. */
	busy: boolean;
}>();

const emit = defineEmits<{ add: []; remove: [adminId: string, email: string] }>();

const { t } = useI18n();

// With nobody to promote, Add admin is held (aria-disabled, not disabled) so
// keyboard and pointer users can still reach it and its tooltip can say why:
// `.btn:disabled` drops pointer events and a disabled button leaves the tab
// order. The fill fades through colour alpha so the focus ring stays at full
// strength; the page's openAddAdmin keeps the held control inert.
const ADD_ADMIN_HELD_CLASS =
	'cursor-not-allowed active:scale-100 bg-surface-3/50 hover:bg-surface-3/50 text-text-primary/50';
</script>

<template>
	<div class="space-y-6">
		<div class="card">
			<div class="flex items-center justify-between mb-4">
				<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider">
					{{ t('dashboard.admin.operator.index.admins.title') }}
				</h3>
				<UiTooltip
					:text="
						hasPromotableUsers ? undefined : t('dashboard.admin.operator.index.admins.allPromoted')
					"
				>
					<UiButton
						variant="secondary"
						size="sm"
						:disabled="busy"
						:aria-disabled="hasPromotableUsers ? undefined : 'true'"
						:class="hasPromotableUsers ? undefined : ADD_ADMIN_HELD_CLASS"
						data-testid="operator-add-admin"
						@click="emit('add')"
					>
						<template #iconLeft>
							<PlusIcon class="w-4 h-4" />
						</template>
						{{ t('dashboard.admin.operator.index.admins.add') }}
					</UiButton>
				</UiTooltip>
			</div>

			<!-- Scroll container: email, role, added and the remove action do not
			     fit a phone, and without this the card just clipped them. The
			     negative margin lets the scroll area bleed to the card's edges. -->
			<div class="-mx-6 px-6 overflow-x-auto">
				<table class="w-full min-w-max text-caption">
					<thead>
						<tr class="border-b border-border-subtle text-text-tertiary">
							<th class="text-left py-2 font-medium">{{ t('common.email') }}</th>
							<th class="text-left py-2 font-medium">
								{{ t('dashboard.admin.operator.index.admins.role') }}
							</th>
							<th class="text-left py-2 font-medium">
								{{ t('dashboard.admin.operator.index.admins.added') }}
							</th>
							<th class="text-right py-2 font-medium" />
						</tr>
					</thead>
					<tbody>
						<tr
							v-for="a in admins ?? []"
							:key="a.id"
							class="border-b border-border-subtle last:border-b-0"
						>
							<td class="py-2 text-text-primary">{{ a.email }}</td>
							<td class="py-2">
								<UiBadge :variant="a.role === 'superadmin' ? 'warning' : 'neutral'">{{
									a.role
								}}</UiBadge>
							</td>
							<td class="py-2 text-text-secondary">{{ formatRelativeTime(a.createdAt) }}</td>
							<td class="py-2 text-right">
								<UiButton
									variant="danger-ghost"
									size="sm"
									:disabled="busy"
									@click="emit('remove', a.id, a.email)"
								>
									{{ t('common.remove') }}
								</UiButton>
							</td>
						</tr>
					</tbody>
				</table>
			</div>
			<p class="mt-3 text-xs text-text-tertiary">
				{{ t('dashboard.admin.operator.index.admins.footnote') }}
			</p>
		</div>
	</div>
</template>
