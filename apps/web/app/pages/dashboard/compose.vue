<script setup lang="ts">
/**
 * The composer, the whole screen: a new message, a reopened draft, a forward
 * as new mail or a resend. The same editor Answer mode writes replies in, with
 * the envelope open and no conversation beside it. It replaced the floating
 * popup in the corner.
 *
 *   /dashboard/compose?c=<key>                         a compose request (usePostboxComposeNav)
 *   /dashboard/compose?c=<key>&mailbox=<id>&draft=<id> …that has a saved draft
 *   /dashboard/compose?to=…&cc=…&subject=…             a plain link: given a request first
 *
 * `c` names the compose request and keys the page, so a second open while this
 * one is on screen remounts the editor. A URL without one (a link, a contact)
 * is given a request before any composer mounts, so every composer here has a
 * request nonce and a remount reaches the same row. An unknown or expired `c`
 * says so rather than starting a second composition under the same name.
 *
 * Unsaved text and the request record (parking on a leave, resolving parked
 * text on a return) are `usePostboxComposePageRequest`'s. The URL names the
 * draft (`&draft=`) once the text the request was opened with is confirmed
 * saved. Esc or "← Inbox" goes back to the page it came from; the draft stays
 * saved in Drafts. A send leaves too, and the shell's undo toast keeps counting
 * down over the page underneath.
 */
import { splitMailtoAddressList } from '@owlat/shared/mailto';
import type { Id } from '@owlat/api/dataModel';
import { composePageKey, type ComposeSpec } from '~/composables/postbox/usePostboxComposeNav';
import {
	usePostboxComposePageRequest,
	type ComposePageComposer,
} from '~/composables/postbox/usePostboxComposePageRequest';
import { useKeyboardInset } from '~/composables/useKeyboardInset';
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
	// One page instance per compose request; the page's own URL rewrite keeps `c`.
	key: (route) => composePageKey(route.query['c']),
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

const requestKey = singleQueryValue(route.query['c']);
const urlMailbox = singleQueryValue(route.query['mailbox']) as Id<'mailboxes'> | null;
const urlDraft = singleQueryValue(route.query['draft']) as Id<'mailDrafts'> | null;

/** The prefill a plain link carries in its query, or null when it has none. */
function queryPrefill(): Partial<ComposeSpec> | null {
	const list = (key: string) => {
		const raw = singleQueryValue(route.query[key]);
		return raw ? splitMailtoAddressList(raw) : undefined;
	};
	const prefill = {
		prefillTo: list('to'),
		prefillCc: list('cc'),
		prefillBcc: list('bcc'),
		prefillSubject: singleQueryValue(route.query['subject']) ?? undefined,
	};
	return Object.values(prefill).some((value) => value !== undefined) ? prefill : null;
}

const composerRef = ref<ComposePageComposer | null>(null);
const request = usePostboxComposePageRequest({ nav, composer: composerRef });
const { seed } = request;

if (requestKey) {
	request.openRequest(
		requestKey,
		urlMailbox && urlDraft ? { mailboxId: urlMailbox, draftId: urlDraft } : undefined
	);
} else {
	// A plain link: give it a request once the mailbox it needs is known. The
	// rewrite changes the page key, so the page mounts again under it.
	const stop = watchEffect(() => {
		const mailboxId = urlMailbox ?? currentMailbox.value?._id;
		if (!mailboxId) return;
		queueMicrotask(() => stop());
		const spec: ComposeSpec = urlDraft
			? { mailboxId, draftId: urlDraft }
			: { mailboxId, ...queryPrefill() };
		const key = nav.create(spec);
		void router.replace({
			query: { c: key, ...(urlDraft ? { mailbox: mailboxId, draft: urlDraft } : {}) },
		});
	});
}

watch(composerRef, (mounted) => {
	if (mounted) request.bindComposer(mounted);
});

// Set as the page goes: a save still in flight then must not touch the URL,
// which by now belongs to whatever page came next.
let closed = false;
const isClosed = () => closed;

/** Name the draft in the URL (only the request this page shows). */
function nameDraftInUrl(draftId: Id<'mailDrafts'>) {
	const own = request.state.value;
	if (closed || own.status !== 'ready' || !seed.value) return;
	const current = router.currentRoute.value;
	if (singleQueryValue(current.query['c']) !== own.key) return;
	if (singleQueryValue(current.query['draft']) === draftId) return;
	void router.replace({
		query: { c: own.key, mailbox: seed.value.mailboxId, draft: draftId },
	});
}

let confirming: Promise<void> | null = null;
let confirmAgain = false;
/**
 * While the request still carries text the server may not hold, ask the
 * composer to save what is on screen; once it has, the request drops that text
 * and the URL names the draft. A request that arrives mid-save runs once more
 * afterwards, so a later save is never dropped behind an earlier, failed one.
 */
async function confirmSaved(): Promise<void> {
	if (closed || !composerRef.value || !request.carriesText()) return;
	if (confirming) {
		confirmAgain = true;
		return confirming;
	}
	confirming = (async () => {
		try {
			do {
				confirmAgain = false;
				const saved = await composerRef.value?.flush();
				if (saved?.ok && saved.result) {
					request.savedAcknowledged(saved.result);
					nameDraftInUrl(saved.result);
				}
			} while (confirmAgain && request.carriesText() && !isClosed());
		} finally {
			confirming = null;
		}
	})();
	return confirming;
}

// A save landed: text merged back from an earlier leave may be held now.
function onSaved() {
	void request.settleMerged();
	void confirmSaved();
}

function onDraftId(draftId: Id<'mailDrafts'>) {
	if (request.carriesText()) void confirmSaved();
	else nameDraftInUrl(draftId);
}

// Sent or discarded: the composition is over, and nothing is left to park.
function finish() {
	request.finish();
	leave();
}

function startNew() {
	const mailboxId = currentMailbox.value?._id;
	if (mailboxId) void nav.open({ mailboxId });
}

const subject = ref('');
useHead({ title: () => subject.value || t('components.postbox.postboxComposer.newMessage') });

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

// A tab closed or reloaded never unmounts the page: park on `pagehide` too.
function onPageHide() {
	request.parkOnLeave();
}

onMounted(() => {
	window.addEventListener('keydown', onKeydown);
	window.addEventListener('pagehide', onPageHide);
});
onBeforeUnmount(() => {
	window.removeEventListener('keydown', onKeydown);
	window.removeEventListener('pagehide', onPageHide);
	closed = true;
	request.parkOnLeave();
});

// The on-screen keyboard shrinks the visual viewport but not `100dvh`: leave it
// out of the frame, so Send stays above it, as Answer mode does.
const keyboard = useKeyboardInset();
const frameStyle = computed(() => ({
	'--compose-keyboard-inset': `${keyboard.value}px`,
	// The home indicator sits under the keyboard while one is open.
	'--compose-bottom-inset': keyboard.value > 0 ? '0px' : 'env(safe-area-inset-bottom, 0px)',
}));
</script>

<template>
	<div
		class="flex h-[calc(100dvh-var(--titlebar-h,0px)-var(--compose-keyboard-inset,0px))] flex-col bg-bg-base pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)]"
		:style="frameStyle"
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

		<main
			class="flex min-h-0 flex-1 justify-center overflow-hidden pb-(--compose-bottom-inset) md:px-6 md:py-6"
		>
			<div
				class="flex min-h-0 w-full max-w-3xl flex-col overflow-hidden bg-bg-elevated md:rounded-lg md:border md:border-border-subtle md:shadow-sm"
			>
				<PostboxComposer
					v-if="seed"
					ref="composerRef"
					class="min-h-0 flex-1"
					frame="page"
					:seed="seed"
					:before-ready="request.beforeReady"
					:reply-all-recipients="seed.replyAllRecipients"
					@draft-id="onDraftId"
					@saved="onSaved"
					@subject="subject = $event"
					@sent="finish"
					@discarded="finish"
					@minimize="onComposerEsc"
				/>
				<div
					v-else-if="request.state.value.status === 'expired'"
					class="m-auto flex flex-col items-center gap-3 p-6 text-center"
					data-testid="compose-expired"
				>
					<p class="text-sm text-text-secondary">{{ t('compose.requestExpired') }}</p>
					<UiButton size="sm" type="button" :disabled="!currentMailbox" @click="startNew">
						{{ t('compose.startNew') }}
					</UiButton>
				</div>
				<div v-else-if="isLoading || (!requestKey && currentMailbox)" class="flex-1 space-y-3 p-4" aria-hidden="true">
					<UiSkeleton class="h-4 w-2/3" />
					<UiSkeleton class="h-32 w-full" />
				</div>
				<p v-else class="m-auto p-6 text-sm text-text-secondary">{{ t('compose.noMailbox') }}</p>
			</div>
		</main>
	</div>
</template>
