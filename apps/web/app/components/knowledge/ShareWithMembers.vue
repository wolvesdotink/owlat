<script setup lang="ts">
/**
 * "Share with members" for a knowledge entry members cannot see (#1372).
 *
 * Migration 0069 made every older entry owner/admin-only, because a past merge
 * may have folded private text, tags or contact links into it. This opens a
 * review of the complete entry, as the backend sees it, before an owner or
 * admin shares it (knowledge/sharing.ts). The review shown is kept still: when
 * the entry changes underneath it, the dialog says so and sharing waits for a
 * look at the new version, and the backend refuses a share of a version
 * nobody reviewed. A review that fails to load says so with Try again, and one
 * the backend no longer returns (the entry was deleted, or the viewer lost the
 * right to share) says that; neither leaves the dialog loading, and neither
 * can be confirmed.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';

type ShareReview = NonNullable<FunctionReturnType<typeof api.knowledge.sharing.getShareReview>>;

const props = defineProps<{ entryId: Id<'knowledgeEntries'> }>();

const { t } = useI18n();
const { showToast } = useToast();

const open = ref(false);
const {
	data: liveReview,
	error: reviewError,
	refetch: refetchReview,
} = useOrganizationQuery(api.knowledge.sharing.getShareReview, () =>
	open.value ? { entryId: props.entryId } : undefined
);
/** The backend answered and has no review to give: gone, or no longer ours to share. */
const isUnavailable = computed(() => liveReview.value === null);

/** The version on screen; the live one only replaces it when asked to. */
const reviewed = ref<ShareReview | null>(null);
watch(liveReview, (live) => {
	if (live && !reviewed.value) reviewed.value = live;
});
const hasChanged = computed(
	() =>
		!!liveReview.value &&
		!!reviewed.value &&
		liveReview.value.fingerprint !== reviewed.value.fingerprint
);
const blockedCopy = computed(() =>
	reviewed.value?.blocker
		? t(`components.knowledge.shareWithMembers.blocked.${reviewed.value.blocker}`)
		: null
);

const share = useBackendOperation(api.knowledge.sharing.shareWithMembers, {
	label: () => t('components.knowledge.shareWithMembers.operation'),
});
const canConfirm = computed(
	() =>
		!!reviewed.value &&
		reviewed.value.blocker === null &&
		!hasChanged.value &&
		!reviewError.value &&
		!isUnavailable.value &&
		!share.isLoading.value
);

function start(): void {
	reviewed.value = null;
	open.value = true;
}

function close(): void {
	open.value = false;
	reviewed.value = null;
}

function showLatest(): void {
	reviewed.value = liveReview.value ?? null;
}

async function confirm(): Promise<void> {
	if (!reviewed.value || !canConfirm.value) return;
	const result = await share.run({
		entryId: props.entryId,
		fingerprint: reviewed.value.fingerprint,
	});
	if (!result.ok) return;
	showToast(t('components.knowledge.shareWithMembers.sharedToast'));
	close();
}
</script>

<template>
	<UiButton variant="secondary" class="gap-2" @click="start">
		<Icon name="lucide:users" class="w-4 h-4" />
		{{ t('components.knowledge.shareWithMembers.action') }}
	</UiButton>

	<UiModal
		:open="open"
		:title="t('components.knowledge.shareWithMembers.title')"
		size="xl"
		@update:open="(value: boolean) => !value && close()"
	>
		<div v-if="reviewError" data-testid="share-load-failed">
			<UiQueryBoundary
				:error="reviewError"
				:error-title="t('components.knowledge.shareWithMembers.loadFailed')"
				@retry="refetchReview"
			/>
		</div>
		<p
			v-else-if="isUnavailable"
			class="flex items-start gap-2 rounded-lg bg-bg-surface p-3 text-sm text-text-secondary"
			data-testid="share-unavailable"
		>
			<Icon name="lucide:eye-off" class="w-4 h-4 mt-0.5 text-text-tertiary shrink-0" />
			<span>{{ t('components.knowledge.shareWithMembers.unavailable') }}</span>
		</p>
		<p v-else-if="!reviewed" class="text-sm text-text-tertiary">
			{{ t('components.knowledge.shareWithMembers.loading') }}
		</p>
		<div v-else class="space-y-4" data-testid="share-review">
			<p class="text-sm text-text-secondary">
				{{ t('components.knowledge.shareWithMembers.intro') }}
			</p>

			<div
				v-if="blockedCopy"
				class="flex items-start gap-2 rounded-lg bg-warning/10 p-3 text-sm text-text-primary"
				data-testid="share-blocked"
			>
				<Icon name="lucide:lock" class="w-4 h-4 mt-0.5 text-warning shrink-0" />
				<span>{{ blockedCopy }}</span>
			</div>

			<div
				v-if="hasChanged"
				class="flex items-center justify-between gap-3 rounded-lg bg-warning/10 p-3 text-sm text-text-primary"
				data-testid="share-changed"
			>
				<span>{{ t('components.knowledge.shareWithMembers.changedNotice') }}</span>
				<UiButton size="sm" variant="secondary" @click="showLatest">
					{{ t('components.knowledge.shareWithMembers.showLatest') }}
				</UiButton>
			</div>

			<section>
				<h4 class="text-xs font-medium text-text-tertiary mb-1">
					{{ t('components.knowledge.shareWithMembers.titleLabel') }}
				</h4>
				<p class="text-sm font-medium text-text-primary">{{ reviewed.title }}</p>
			</section>

			<section>
				<h4 class="text-xs font-medium text-text-tertiary mb-1">
					{{ t('components.knowledge.shareWithMembers.content') }}
				</h4>
				<p
					class="max-h-64 overflow-y-auto rounded-lg bg-bg-surface p-3 text-sm text-text-secondary whitespace-pre-wrap leading-relaxed"
					data-testid="share-content"
				>
					{{ reviewed.content }}
				</p>
			</section>

			<section>
				<h4 class="text-xs font-medium text-text-tertiary mb-1">
					{{ t('components.knowledge.shareWithMembers.tags') }}
				</h4>
				<div v-if="reviewed.tags.length > 0" class="flex flex-wrap gap-2">
					<span
						v-for="tag in reviewed.tags"
						:key="tag"
						class="text-xs px-2.5 py-1 rounded-full bg-bg-surface text-text-secondary border border-border-subtle"
						data-testid="share-tag"
					>
						{{ tag }}
					</span>
				</div>
				<p v-else class="text-sm text-text-tertiary">
					{{ t('components.knowledge.shareWithMembers.noTags') }}
				</p>
			</section>

			<section>
				<h4 class="text-xs font-medium text-text-tertiary mb-1">
					{{ t('components.knowledge.shareWithMembers.contacts') }}
				</h4>
				<ul v-if="reviewed.contacts.length > 0" class="space-y-1">
					<li
						v-for="contact in reviewed.contacts"
						:key="contact.contactId"
						class="flex items-center gap-2 text-sm"
						data-testid="share-contact"
					>
						<Icon name="lucide:user" class="w-3.5 h-3.5 text-text-tertiary shrink-0" />
						<template v-if="contact.name || contact.email">
							<NuxtLink
								:to="`/dashboard/audience/contacts/${contact.contactId}`"
								class="text-text-primary hover:text-brand truncate"
							>
								{{ contact.name ?? contact.email }}
							</NuxtLink>
							<span v-if="contact.name && contact.email" class="text-text-tertiary truncate">
								{{ contact.email }}
							</span>
						</template>
						<span v-else class="text-text-tertiary">
							{{ t('components.knowledge.shareWithMembers.deletedContact') }}
						</span>
					</li>
				</ul>
				<p v-else class="text-sm text-text-tertiary">
					{{ t('components.knowledge.shareWithMembers.noContacts') }}
				</p>
			</section>
		</div>

		<template #footer>
			<UiButton variant="secondary" @click="close">
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton
				:disabled="!canConfirm"
				:loading="share.isLoading.value"
				data-testid="share-confirm"
				@click="confirm"
			>
				{{
					share.isLoading.value
						? t('components.knowledge.shareWithMembers.sharing')
						: t('components.knowledge.shareWithMembers.confirm')
				}}
			</UiButton>
		</template>
	</UiModal>
</template>
