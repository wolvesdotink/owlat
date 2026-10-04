<script setup lang="ts">
/**
 * The composer, the whole screen: a new message, a reopened draft, a forward
 * as new mail or a resend. The same editor Answer mode writes replies in, with
 * the envelope open and no conversation beside it. It replaced the floating
 * popup in the corner.
 *
 *   /dashboard/compose?seed=<key>               a seed parked by usePostboxComposeNav
 *   /dashboard/compose?draft=<id>&mailbox=<id>  a saved draft
 *   /dashboard/compose?to=…&cc=…&subject=…      a plain prefill (a link, a contact)
 *
 * The first autosave writes `?draft=` into the URL (replace), so a reload lands
 * on the same draft. Esc or "← Inbox" goes back to the page it came from; the
 * draft stays saved in Drafts. A send leaves too, and the shell's undo toast
 * keeps counting down over the page underneath.
 */
import { splitMailtoAddressList } from '@owlat/shared/mailto';
import type { Id } from '@owlat/api/dataModel';
import type { ComposeSpec } from '~/composables/postbox/usePostboxComposeNav';
import { answerBackLabelKey, singleQueryValue } from '~/utils/answerMode';
import { isDialogOpen } from '~/utils/dialogOpen';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import { isImeComposing } from '~/utils/imeComposition';

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
	// Focus mode, like Answer mode: the shell's sidebar and header step aside.
	answerMode: true,
});

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const nav = usePostboxComposeNav();
const { currentMailbox, isLoading } = usePostboxMailbox();

const FALLBACK_RETURN = '/dashboard/postbox/inbox';
// Where "←" leads: the page this was opened from, when there is one.
const returnPath =
	typeof window === 'undefined'
		? null
		: ((window.history.state?.back as string | null | undefined) ?? null);
const backLabel = computed(() => t(answerBackLabelKey(returnPath ?? FALLBACK_RETURN)));

/** The seed the URL names, or null until the mailbox it needs has loaded. */
function resolveSeed(): ComposeSpec | null {
	const parkedKey = singleQueryValue(route.query['seed']);
	const parked = parkedKey ? nav.seedFor(parkedKey) : null;
	if (parked) return parked;
	const mailboxId = (singleQueryValue(route.query['mailbox']) ??
		currentMailbox.value?._id) as Id<'mailboxes'> | undefined;
	if (!mailboxId) return null;
	const draftId = singleQueryValue(route.query['draft']);
	if (draftId) return { mailboxId, draftId: draftId as Id<'mailDrafts'> };
	const list = (key: string) => {
		const raw = singleQueryValue(route.query[key]);
		return raw ? splitMailtoAddressList(raw) : undefined;
	};
	return {
		mailboxId,
		prefillTo: list('to'),
		prefillCc: list('cc'),
		prefillBcc: list('bcc'),
		prefillSubject: singleQueryValue(route.query['subject']) ?? undefined,
	};
}

// The composer reads its seed once: resolve it the first time it can be, then
// keep it, so the URL rewrite after the first autosave does not rebuild it.
const seed = ref<ComposeSpec | null>(null);
watchEffect(() => {
	if (!seed.value) seed.value = resolveSeed();
});

const subject = ref('');
useHead({ title: () => subject.value || t('components.postbox.postboxComposer.newMessage') });

function onDraftId(draftId: Id<'mailDrafts'>) {
	if (route.query['draft'] === draftId || !seed.value) return;
	void router.replace({ query: { mailbox: seed.value.mailboxId, draft: draftId } });
}

function leave() {
	if (returnPath) {
		router.back();
		return;
	}
	void navigateTo(FALLBACK_RETURN, { replace: true });
}

// Esc inside the editor only blurs it; a second Esc (or one from outside a
// field) leaves. An open dialog keeps its own Esc.
function onKeydown(event: KeyboardEvent) {
	if (event.key !== 'Escape' || event.defaultPrevented || isImeComposing(event)) return;
	if (isDialogOpen()) return;
	event.preventDefault();
	const active = document.activeElement;
	if (isEditableTarget(active) && active instanceof HTMLElement) active.blur();
	else leave();
}

function onComposerEsc() {
	const active = document.activeElement;
	if (active instanceof HTMLElement) active.blur();
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
	<div
		class="flex h-[calc(100dvh-var(--titlebar-h,0px))] flex-col bg-bg-base pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)]"
		data-testid="compose-page"
	>
		<header
			class="flex items-center gap-3 border-b border-border-subtle bg-bg-elevated px-3 py-2 pt-[calc(env(safe-area-inset-top,0px)+0.5rem)] md:px-4"
		>
			<button
				type="button"
				class="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-text-secondary hover:bg-bg-surface hover:text-text-primary focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
				:aria-label="t('components.answer.mode.back', { page: backLabel })"
				data-testid="compose-back"
				@click="leave"
			>
				<Icon name="lucide:arrow-left" class="size-4" />
				<span class="max-md:hidden">{{ backLabel }}</span>
				<kbd class="font-mono text-2xs text-text-tertiary max-md:hidden pointer-coarse:hidden">
					Esc
				</kbd>
			</button>
			<h1 class="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
				{{ subject || t('components.postbox.postboxComposer.newMessage') }}
			</h1>
		</header>

		<main class="flex min-h-0 flex-1 justify-center overflow-hidden md:px-6 md:py-6">
			<div
				class="flex min-h-0 w-full max-w-3xl flex-col overflow-hidden bg-bg-elevated md:rounded-lg md:border md:border-border-subtle md:shadow-sm"
			>
				<PostboxComposer
					v-if="seed"
					class="min-h-0 flex-1"
					frame="page"
					:seed="seed"
					:reply-all-recipients="seed.replyAllRecipients"
					@draft-id="onDraftId"
					@subject="subject = $event"
					@sent="leave"
					@discarded="leave"
					@minimize="onComposerEsc"
				/>
				<div v-else-if="isLoading" class="flex-1 space-y-3 p-4" aria-hidden="true">
					<UiSkeleton class="h-4 w-2/3" />
					<UiSkeleton class="h-32 w-full" />
				</div>
				<p v-else class="m-auto p-6 text-sm text-text-secondary">{{ t('compose.noMailbox') }}</p>
			</div>
		</main>
	</div>
</template>
