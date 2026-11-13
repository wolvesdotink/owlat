<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { CheckIcon, CloseIcon, CopyIcon, PlusIcon, ShareAltIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';
import { useEscapeToClose } from '~/composables/useEscapeToClose';
import { formatCompactRelativeTime } from '~/utils/formatters';

const props = defineProps<{
	emailTemplateId?: Id<'emailTemplates'>;
	transactionalEmailId?: Id<'transactionalEmails'>;
	hasUnsavedChanges: boolean;
}>();

const { t } = useI18n();
const isOpen = ref(false);
const isCreating = ref(false);
const { copy: copyToClipboard, copiedKey: copiedId } = useCopyToClipboard({ notify: false });
const triggerRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);

const panelRightPx = computed(() => {
	if (!triggerRef.value) return '0';
	return `${document.documentElement.clientWidth - triggerRef.value.getBoundingClientRect().right}px`;
});

const { showToast } = useToast();
const confirm = useConfirm();

// The whole popover is an admin surface: minting, revoking AND listing are all
// held to `shareLinks:manage` (a row carries the bearer token for the public
// /share route). For an editor the query would throw and the panel would show
// an empty list that no button could fill, so the trigger is not offered at all
// and the query is skipped — the same shape the admin settings pages use.
const { can } = usePermissions();
const canShare = computed(() => can('shareLinks:manage'));

// Query existing share links
const queryArgs = computed(() => {
	if (!canShare.value) return 'skip' as const;
	if (props.emailTemplateId) return { emailTemplateId: props.emailTemplateId };
	if (props.transactionalEmailId) return { transactionalEmailId: props.transactionalEmailId };
	return 'skip' as const;
});

const { data: shareLinks } = useConvexQuery(
	api.shareLinks.links.listShareLinks,
	() => queryArgs.value
);

// Mutations
const { run: createShareLink } = useBackendOperation(api.shareLinks.links.createShareLink, {
	label: () => t('components.shareLinksPopover.createOperation'),
});
const { run: revokeShareLink } = useBackendOperation(api.shareLinks.links.revokeShareLink, {
	label: () => t('components.shareLinksPopover.revokeOperation'),
});

const config = useRuntimeConfig();

const shareUrl = (token: string) => {
	const siteUrl = config.public['siteUrl'] || window.location.origin;
	return `${siteUrl}/share?token=${encodeURIComponent(token)}`;
};

// The link whose copy the browser refused: its row shows the URL to select by hand.
const copyFailedUrl = ref<string | null>(null);

const handleCreate = async () => {
	isCreating.value = true;
	try {
		const result = await createShareLink({
			emailTemplateId: props.emailTemplateId,
			transactionalEmailId: props.transactionalEmailId,
		});
		if (result.ok && result.result.url) {
			const copied = await copyToClipboard(result.result.url);
			copyFailedUrl.value = copied ? null : result.result.url;
			showToast(
				copied
					? t('components.shareLinksPopover.createdToast')
					: t('components.shareLinksPopover.createdNotCopiedToast'),
				'success'
			);
		}
	} finally {
		isCreating.value = false;
	}
};

// Revoking cuts off everyone the link already went to, and there is no way to
// bring the same link back: ask first.
const handleRevoke = async (shareLinkId: Id<'shareLinks'>) => {
	const confirmed = await confirm({
		title: t('components.shareLinksPopover.revokeConfirmTitle'),
		body: t('components.shareLinksPopover.revokeConfirmBody'),
		confirmText: t('components.shareLinksPopover.revokeLink'),
		variant: 'danger',
	});
	if (!confirmed) return;
	const result = await revokeShareLink({ shareLinkId });
	if (!result.ok) return;
	showToast(t('components.shareLinksPopover.revokedToast'), 'success');
};

const handleCopy = async (token: string) => {
	const url = shareUrl(token);
	const copied = await copyToClipboard(url, token);
	copyFailedUrl.value = copied ? null : url;
	if (!copied) showToast(t('components.shareLinksPopover.copyFailed'), 'error');
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
// and on Escape (the shared Escape stack, so the builder's own Esc stays put).
useClickOutside([panelRef, triggerRef], () => {
	if (isOpen.value) isOpen.value = false;
});
useEscapeToClose(isOpen);

// The panel is teleported to the end of <body>: move focus into it on open, and
// back to the trigger when it closes with focus inside, or a keyboard user would
// have to tab through the whole page to reach it.
watch(isOpen, async (open) => {
	if (open) {
		await nextTick();
		panelRef.value?.querySelector<HTMLElement>('button:not([disabled]), input')?.focus();
		return;
	}
	copyFailedUrl.value = null;
	if (!panelRef.value || panelRef.value.contains(document.activeElement)) {
		triggerRef.value?.querySelector<HTMLElement>('button')?.focus();
	}
});
</script>

<template>
	<div v-if="canShare" class="relative inline-block">
		<div ref="triggerRef">
			<UiTooltip :text="t('components.shareLinksPopover.triggerTitle')">
				<UiButton
					variant="outline"
					size="sm"
					aria-haspopup="dialog"
					:aria-expanded="isOpen"
					@click.stop="isOpen = !isOpen"
				>
					<template #iconLeft>
						<ShareAltIcon class="w-4 h-4" />
					</template>
					<!-- Icon-only below 2xl, where the builder toolbar is short of room;
					     the label stays the accessible name. -->
					<span class="max-2xl:sr-only">{{ t('components.shareLinksPopover.share') }}</span>
				</UiButton>
			</UiTooltip>
		</div>

		<Teleport to="body">
			<Transition
				enter-active-class="duration-(--motion-moderate) ease-spring"
				enter-from-class="opacity-0 scale-95"
				enter-to-class="opacity-100 scale-100"
				leave-active-class="duration-(--motion-moderate-exit) ease-exit"
				leave-from-class="opacity-100 scale-100"
				leave-to-class="opacity-0 scale-95"
			>
				<div
					v-if="isOpen"
					ref="panelRef"
					role="dialog"
					:aria-label="t('components.shareLinksPopover.panelTitle')"
					class="fixed z-(--z-menu) w-[min(20rem,calc(100vw-2rem))] bg-bg-elevated border border-border-subtle rounded-lg shadow-lg"
					:style="{
						top: triggerRef ? `${triggerRef.getBoundingClientRect().bottom + 8}px` : '0',
						right: panelRightPx,
					}"
				>
					<div class="p-3 border-b border-border-subtle">
						<h3 class="text-sm font-medium text-text-primary">
							{{ t('components.shareLinksPopover.panelTitle') }}
						</h3>
						<p class="text-xs text-text-tertiary mt-0.5">
							{{ t('components.shareLinksPopover.panelSubtitle') }}
						</p>
					</div>

					<!-- Create button -->
					<div class="p-3 border-b border-border-subtle">
						<UiTooltip
							:text="
								hasUnsavedChanges
									? t('components.shareLinksPopover.saveFirst')
									: t('components.shareLinksPopover.createTitle')
							"
						>
							<UiButton
								size="sm"
								class="w-full"
								:disabled="hasUnsavedChanges || isCreating"
								@click="handleCreate"
							>
								<template #iconLeft>
									<SpinnerIcon v-if="isCreating" class="w-4 h-4" />
									<PlusIcon v-else class="w-4 h-4" />
								</template>
								{{
									isCreating
										? t('components.shareLinksPopover.creating')
										: t('components.shareLinksPopover.create')
								}}
							</UiButton>
						</UiTooltip>
						<p v-if="hasUnsavedChanges" class="text-xs text-text-tertiary mt-1.5">
							{{ t('components.shareLinksPopover.unsavedHint') }}
						</p>
						<!-- The browser refused the copy: the link to select by hand. -->
						<input
							v-if="copyFailedUrl"
							type="text"
							readonly
							class="input input-sm mt-2 w-full font-mono"
							:value="copyFailedUrl"
							:aria-label="t('components.shareLinksPopover.linkUrlLabel')"
							@focus="($event.target as HTMLInputElement).select()"
						/>
					</div>

					<!-- Link list -->
					<div class="max-h-60 overflow-y-auto">
						<div
							v-if="!shareLinks?.length"
							class="px-3 py-4 text-center text-xs text-text-tertiary"
						>
							{{ t('components.shareLinksPopover.empty') }}
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
									class="text-xs text-success font-medium whitespace-nowrap"
								>
									{{
										t('components.shareLinksPopover.activeStatus', {
											hours: getHoursRemaining(link.expiresAt),
										})
									}}
								</span>
								<span
									v-else-if="getLinkStatus(link) === 'expired'"
									class="text-xs text-text-tertiary font-medium"
								>
									{{ t('components.shareLinksPopover.expired') }}
								</span>
								<span v-else class="text-xs text-error font-medium">
									{{ t('components.shareLinksPopover.revoked') }}
								</span>
								<!-- Tells two links apart: they share a status line otherwise. -->
								<span class="min-w-0 flex-1 truncate text-2xs text-text-tertiary">
									{{
										t('components.shareLinksPopover.createdAt', {
											time: formatCompactRelativeTime(link._creationTime),
										})
									}}
								</span>

								<!-- Actions -->
								<div class="flex items-center gap-1">
									<UiTooltip
										v-if="getLinkStatus(link) === 'active'"
										:text="t('components.shareLinksPopover.copyLink')"
									>
										<button
											type="button"
											class="p-1 rounded hover:bg-bg-surface text-text-secondary hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand pointer-coarse:flex pointer-coarse:size-11 pointer-coarse:items-center pointer-coarse:justify-center"
											:aria-label="t('components.shareLinksPopover.copyLink')"
											@click="handleCopy(link.token)"
										>
											<component
												:is="copiedId === link.token ? CheckIcon : CopyIcon"
												class="w-3.5 h-3.5"
											/>
										</button>
									</UiTooltip>
									<UiTooltip
										v-if="getLinkStatus(link) === 'active'"
										:text="t('components.shareLinksPopover.revokeLink')"
									>
										<button
											type="button"
											class="p-1 rounded hover:bg-error/10 text-text-secondary hover:text-error transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand pointer-coarse:flex pointer-coarse:size-11 pointer-coarse:items-center pointer-coarse:justify-center"
											:aria-label="t('components.shareLinksPopover.revokeLink')"
											@click="handleRevoke(link._id)"
										>
											<CloseIcon class="w-3.5 h-3.5" />
										</button>
									</UiTooltip>
								</div>
							</div>
						</div>
					</div>
				</div>
			</Transition>
		</Teleport>
	</div>
</template>
