<script setup lang="ts">
import type { OrganizationMember, OrganizationRole } from '~/composables/useOrganization';
import { useLocalized } from '~/composables/useLocalized';
import { formatDate } from '~/utils/formatters';
import { roleDefinition, type MailboxStatusMeta } from '~/utils/teamRoles';
import {
	CrownIcon,
	MailIcon,
	MoreHorizontalIcon,
	PaperPlaneIcon,
	SearchIcon,
	TrashIcon,
	UsersIcon,
} from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

/**
 * The roster card: search, the members table with each row's role and
 * mailbox, and the row menu's recovery and removal actions. Presentational:
 * the page owns the roster, the writes and their inflight flags.
 */
defineProps<{
	/** The whole roster, for the count; the table shows `filteredMembers`. */
	memberCount: number;
	filteredMembers: OrganizationMember[];
	canManageMembers: boolean;
	isOwner: boolean;
	isMailboxStatusPending: boolean;
	mailboxMetaFor: (userId: string) => MailboxStatusMeta;
	verifyingMemberId: string | null;
	resendingVerifyId: string | null;
}>();

const memberSearch = defineModel<string>('memberSearch', { required: true });

const emit = defineEmits<{
	invite: [];
	roleChange: [memberId: string, role: OrganizationRole];
	markVerified: [member: OrganizationMember];
	resendVerification: [member: OrganizationMember];
	transfer: [member: OrganizationMember];
	remove: [member: OrganizationMember];
}>();

const { t, locale } = useI18n();

/**
 * `utils/teamRoles` is a module-scope definition set whose label/summary/detail
 * carry i18n keys rather than sentences (the registry convention); a plain string
 * is still accepted so a value with nothing to translate reads as itself.
 */
const localized = useLocalized();

// Role change dropdown state (using reactive object for AppDropdownMenu v-model:open per member)
const dropdownOpenStates = reactive<Record<string, boolean>>({});
</script>

<template>
	<UiCard padding="none">
		<template #header>
			<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
				<div class="flex items-center gap-3">
					<UiIconBox :icon="UsersIcon" size="sm" variant="surface" rounded="lg" />
					<div>
						<h2 class="text-lg font-semibold text-text-primary">
							{{ t('dashboard.admin.team.members.title') }}
						</h2>
						<p class="text-sm text-text-secondary">
							{{ t('dashboard.admin.team.members.count', { count: memberCount }, memberCount) }}
						</p>
					</div>
				</div>
				<!-- Search box above the table -->
				<div class="sm:w-64">
					<label for="team-member-search" class="sr-only">{{
						t('dashboard.admin.team.members.searchLabel')
					}}</label>
					<UiInput
						id="team-member-search"
						v-model="memberSearch"
						type="text"
						size="sm"
						:placeholder="t('dashboard.admin.team.members.searchPlaceholder')"
					>
						<template #iconLeft>
							<SearchIcon class="w-4 h-4 text-text-tertiary" />
						</template>
					</UiInput>
				</div>
			</div>
		</template>

		<!-- Empty: no members match the search -->
		<UiEmptyState
			v-if="filteredMembers.length === 0 && memberSearch.trim()"
			:icon="SearchIcon"
			:title="t('dashboard.admin.team.members.noMatchesTitle')"
			:description="
				t('dashboard.admin.team.members.noMatchesDescription', {
					query: memberSearch.trim(),
				})
			"
		>
			<template #action>
				<UiButton variant="secondary" size="sm" @click="memberSearch = ''">
					{{ t('dashboard.admin.team.members.clearSearch') }}
				</UiButton>
			</template>
		</UiEmptyState>

		<!-- Empty: nobody on the roster yet (no search term) -->
		<UiEmptyState
			v-else-if="filteredMembers.length === 0"
			:icon="UsersIcon"
			:title="t('dashboard.admin.team.members.emptyTitle')"
			:description="t('dashboard.admin.team.members.emptyDescription')"
		>
			<template v-if="canManageMembers" #action>
				<UiButton size="sm" @click="emit('invite')">{{
					t('dashboard.admin.team.members.inviteTeammate')
				}}</UiButton>
			</template>
		</UiEmptyState>

		<!-- Members table. `relative` makes the scroller the containing block of
		     the actions header's absolutely positioned `sr-only` label; without
		     it that label escaped the scroller and widened the page on a phone. -->
		<div v-else class="relative overflow-x-auto">
			<table class="w-full min-w-[36rem] text-sm">
				<thead>
					<tr
						class="border-b border-border-subtle text-left text-xs font-medium text-text-tertiary"
					>
						<th scope="col" class="px-6 py-3 font-medium">
							{{ t('dashboard.admin.team.members.columns.member') }}
						</th>
						<th scope="col" class="px-4 py-3 font-medium">
							{{ t('dashboard.admin.team.members.columns.role') }}
						</th>
						<th scope="col" class="px-4 py-3 font-medium">
							{{ t('dashboard.admin.team.members.columns.mailbox') }}
						</th>
						<th scope="col" class="px-4 py-3 font-medium">
							{{ t('dashboard.admin.team.members.columns.joined') }}
						</th>
						<th scope="col" class="px-6 py-3">
							<span class="sr-only">{{ t('common.actions') }}</span>
						</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-border-subtle">
					<tr v-for="member in filteredMembers" :key="member.id" class="align-middle">
						<!-- Member: avatar + name/email -->
						<td class="px-6 py-4">
							<div class="flex items-center gap-3">
								<div
									v-if="member.user.image"
									class="h-9 w-9 shrink-0 rounded-full bg-cover bg-center"
									:style="{ backgroundImage: `url(${member.user.image})` }"
								/>
								<div
									v-else
									class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-surface"
								>
									<span class="text-sm font-medium text-text-secondary">
										{{ (member.user.name || member.user.email).charAt(0).toUpperCase() }}
									</span>
								</div>
								<div class="min-w-0">
									<p class="truncate font-medium text-text-primary">
										{{ member.user.name || t('dashboard.admin.team.members.noName') }}
									</p>
									<p class="truncate text-sm text-text-secondary">{{ member.user.email }}</p>
								</div>
							</div>
						</td>

						<!-- Role: inline change menu (owner only, non-owner members) -->
						<td class="px-4 py-4">
							<SettingsTeamRoleMenu
								v-if="isOwner && member.role !== 'owner'"
								:role="member.role"
								:member-label="member.user.name || member.user.email"
								@change="(role) => emit('roleChange', member.id, role)"
							/>
							<span
								v-else
								class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium"
								:class="roleDefinition(member.role).badgeToneClass"
							>
								<component :is="roleDefinition(member.role).icon" class="w-3 h-3" />
								{{ localized(roleDefinition(member.role).label) }}
							</span>
						</td>

						<!-- Mailbox: hosted / external / none -->
						<td class="px-4 py-4">
							<span
								v-if="isMailboxStatusPending"
								class="inline-flex items-center gap-1.5 text-sm text-text-tertiary"
								:title="t('dashboard.admin.team.members.mailboxChecking')"
							>
								<SpinnerIcon class="w-3.5 h-3.5" />
								<span class="sr-only">{{ t('dashboard.admin.team.members.mailboxLoading') }}</span>
								<span aria-hidden="true">—</span>
							</span>
							<span
								v-else
								class="inline-flex items-center gap-1.5 text-sm"
								:class="mailboxMetaFor(member.userId).toneClass"
								:title="localized(mailboxMetaFor(member.userId).description)"
							>
								<component :is="mailboxMetaFor(member.userId).icon" class="w-3.5 h-3.5" />
								{{ localized(mailboxMetaFor(member.userId).label) }}
							</span>
						</td>

						<!-- Joined date, always with the year so the column reads as one format -->
						<td class="px-4 py-4 text-text-secondary whitespace-nowrap">
							{{ formatDate(member.createdAt, 'medium', locale) }}
						</td>

						<!-- Overflow menu: verification recovery + ownership/destructive
						     actions. Owners and admins both manage members, so the menu
						     opens for any non-owner row; the owner-only and admin-only
						     entries are gated inside. -->
						<td class="px-6 py-4 text-right">
							<UiDropdownMenu
								v-if="canManageMembers && member.role !== 'owner'"
								v-model:open="dropdownOpenStates[member.id]"
							>
								<template #trigger>
									<UiButton
										variant="ghost"
										size="sm"
										:aria-label="
											t('dashboard.admin.team.members.rowActions', {
												member: member.user.name || member.user.email,
											})
										"
									>
										<MoreHorizontalIcon class="w-4 h-4" />
									</UiButton>
								</template>
								<!-- Email-verification recovery (owner + admin): unblock a
								     member the verification gate stranded. -->
								<UiDropdownMenuItem
									:icon="MailIcon"
									:disabled="verifyingMemberId === member.id"
									@click="emit('markVerified', member)"
								>
									{{ t('dashboard.admin.team.members.markEmailVerified') }}
								</UiDropdownMenuItem>
								<UiDropdownMenuItem
									:icon="PaperPlaneIcon"
									:disabled="resendingVerifyId === member.id"
									@click="emit('resendVerification', member)"
								>
									{{ t('dashboard.admin.team.members.resendVerification') }}
								</UiDropdownMenuItem>
								<!-- Owner-only: succession + removing any member. -->
								<template v-if="isOwner">
									<UiDropdownDivider />
									<UiDropdownMenuItem :icon="CrownIcon" @click="emit('transfer', member)">
										{{ t('dashboard.admin.team.members.transferOwnership') }}
									</UiDropdownMenuItem>
									<UiDropdownDivider />
									<UiDropdownMenuItem :icon="TrashIcon" danger @click="emit('remove', member)">
										{{ t('dashboard.admin.team.members.removeFromTeam') }}
									</UiDropdownMenuItem>
								</template>
								<!-- Admins (non-owners) may remove editors. -->
								<template v-else-if="member.role === 'editor'">
									<UiDropdownDivider />
									<UiDropdownMenuItem :icon="TrashIcon" danger @click="emit('remove', member)">
										{{ t('dashboard.admin.team.members.removeFromTeam') }}
									</UiDropdownMenuItem>
								</template>
							</UiDropdownMenu>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
	</UiCard>
</template>
