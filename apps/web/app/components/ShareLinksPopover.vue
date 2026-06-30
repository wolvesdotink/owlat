<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	emailTemplateId?: Id<'emailTemplates'>;
	transactionalEmailId?: Id<'transactionalEmails'>;
	hasUnsavedChanges: boolean;
}>();

const isOpen = ref(false);
const isCreating = ref(false);
const { copy: copyToClipboard, copiedKey: copiedId } = useCopyToClipboard();
const triggerRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);

const panelRightPx = computed(() => {
	if (!triggerRef.value) return '0';
	return `${document.documentElement.clientWidth - triggerRef.value.getBoundingClientRect().right}px`;
});

const { showToast } = useToast();

// Query existing share links
const queryArgs = computed(() => {
	if (props.emailTemplateId) return { emailTemplateId: props.emailTemplateId };
	if (props.transactionalEmailId) return { transactionalEmailId: props.transactionalEmailId };
	return 'skip' as const;
});

const { data: shareLinks } = useConvexQuery(
	api.shareLinks.listShareLinks,
	() => queryArgs.value
);

// Mutations
const { run: createShareLink } = useBackendOperation(api.shareLinks.createShareLink, {
	label: 'Create share link',
});
const { run: revokeShareLink } = useBackendOperation(api.shareLinks.revokeShareLink, {
	label: 'Revoke share link',
});

const config = useRuntimeConfig();

const handleCreate = async () => {
	isCreating.value = true;
	try {
		const result = await createShareLink({
			emailTemplateId: props.emailTemplateId,
			transactionalEmailId: props.transactionalEmailId,
		});
		if (result?.url) {
			await copyToClipboard(result.url);
			showToast('Share link created and copied to clipboard', 'success');
		}
	} finally {
		isCreating.value = false;
	}
};

const handleRevoke = async (shareLinkId: Id<'shareLinks'>) => {
	const result = await revokeShareLink({ shareLinkId });
	if (result === undefined) return;
	showToast('Share link revoked', 'success');
};

const handleCopy = async (token: string) => {
	const siteUrl = config.public['siteUrl'] || window.location.origin;
	const url = `${siteUrl}/share?token=${encodeURIComponent(token)}`;
	await copyToClipboard(url, token);
};

const getLinkStatus = (link: { expiresAt: number; revokedAt?: number }) => {
	if (link.revokedAt) return 'revoked';
	if (link.expiresAt < Date.now()) return 'expired';
	return 'active';
};

const getHoursRemaining = (expiresAt: number) => {
	const ms = expiresAt - Date.now();
	return Math.max(0, Math.ceil(ms / (1000 * 60 * 60)));
};

// Close on outside click (shared composable owns the listener lifecycle)
// and on Escape.
useClickOutside([panelRef, triggerRef], () => {
	if (isOpen.value) isOpen.value = false;
});
const handleEscape = (event: KeyboardEvent) => {
	if (event.key === 'Escape') isOpen.value = false;
};
watch(isOpen, (open) => {
	if (open) document.addEventListener('keydown', handleEscape);
	else document.removeEventListener('keydown', handleEscape);
});
onUnmounted(() => document.removeEventListener('keydown', handleEscape));
</script>

<template>
	<div class="relative inline-block">
		<div ref="triggerRef">
			<UiButton
				variant="outline"
				size="sm"
				title="Share preview link"
				@click.stop="isOpen = !isOpen"
			>
				<template #iconLeft>
					<Icon name="lucide:share-2" class="w-4 h-4" />
				</template>
				Share
			</UiButton>
		</div>

		<Teleport to="body">
			<Transition
				enter-active-class="duration-150 ease-out"
				enter-from-class="opacity-0 scale-95"
				enter-to-class="opacity-100 scale-100"
				leave-active-class="duration-100 ease-in"
				leave-from-class="opacity-100 scale-100"
				leave-to-class="opacity-0 scale-95"
			>
				<div
					v-if="isOpen"
					ref="panelRef"
					class="fixed z-50 w-80 bg-bg-elevated border border-border-subtle rounded-lg shadow-lg"
					:style="{
						top: triggerRef ? `${triggerRef.getBoundingClientRect().bottom + 8}px` : '0',
						right: panelRightPx,
					}"
				>
					<div class="p-3 border-b border-border-subtle">
						<h3 class="text-sm font-medium text-text-primary">Share Preview</h3>
						<p class="text-xs text-text-tertiary mt-0.5">Create a 48-hour preview link</p>
					</div>

					<!-- Create button -->
					<div class="p-3 border-b border-border-subtle">
						<UiButton
							size="sm"
							class="w-full"
							:disabled="hasUnsavedChanges || isCreating"
							:title="hasUnsavedChanges ? 'Save your changes first' : 'Create a new share link'"
							@click="handleCreate"
						>
							<template #iconLeft>
								<Icon v-if="isCreating" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
								<Icon v-else name="lucide:plus" class="w-4 h-4" />
							</template>
							{{ isCreating ? 'Creating...' : 'Create share link' }}
						</UiButton>
						<p v-if="hasUnsavedChanges" class="text-xs text-text-tertiary mt-1.5">
							Save your changes before creating a share link.
						</p>
					</div>

					<!-- Link list -->
					<div class="max-h-60 overflow-y-auto">
						<div
							v-if="!shareLinks?.length"
							class="px-3 py-4 text-center text-xs text-text-tertiary"
						>
							No share links yet. Create one to share a preview.
						</div>

						<div
							v-for="link in shareLinks"
							:key="link._id"
							class="px-3 py-2 border-b border-border-subtle last:border-b-0"
						>
							<div class="flex items-center justify-between gap-2">
								<!-- Status badge -->
								<span
									v-if="getLinkStatus(link) === 'active'"
									class="text-xs text-green-600 font-medium whitespace-nowrap"
								>
									Active &middot; {{ getHoursRemaining(link.expiresAt) }}h left
								</span>
								<span
									v-else-if="getLinkStatus(link) === 'expired'"
									class="text-xs text-text-tertiary font-medium"
								>
									Expired
								</span>
								<span
									v-else
									class="text-xs text-red-500 font-medium"
								>
									Revoked
								</span>

								<!-- Actions -->
								<div class="flex items-center gap-1">
									<button
										v-if="getLinkStatus(link) === 'active'"
										class="p-1 rounded hover:bg-bg-subtle text-text-secondary hover:text-text-primary transition-colors"
										title="Copy link"
										@click="handleCopy(link.token)"
									>
										<Icon
											:name="copiedId === link.token ? 'lucide:check' : 'lucide:copy'"
											class="w-3.5 h-3.5"
										/>
									</button>
									<button
										v-if="getLinkStatus(link) === 'active'"
										class="p-1 rounded hover:bg-red-50 text-text-secondary hover:text-red-500 transition-colors"
										title="Revoke link"
										@click="handleRevoke(link._id)"
									>
										<Icon name="lucide:x" class="w-3.5 h-3.5" />
									</button>
								</div>
							</div>
						</div>
					</div>
				</div>
			</Transition>
		</Teleport>
	</div>
</template>
