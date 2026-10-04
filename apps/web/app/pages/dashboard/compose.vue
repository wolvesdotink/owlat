<script setup lang="ts">
/**
 * The composer, the whole screen: a new message, a reopened draft, a forward
 * as new mail or a resend. The same editor Answer mode writes replies in, with
 * the envelope open and no conversation beside it. It replaced the floating
 * popup in the corner.
 *
 *   /dashboard/compose?c=<key>                         a seed parked by usePostboxComposeNav
 *   /dashboard/compose?c=<key>&mailbox=<id>&draft=<id> a saved draft
 *   /dashboard/compose?to=…&cc=…&subject=…             a plain prefill (a link, a contact)
 *
 * `c` names the compose request and keys the page, so a second open while this
 * one is on screen remounts the editor (the first draft saves on the way out).
 *
 * The URL names the draft (`&draft=`, replacing the seed or prefill) only once
 * the composer confirms the text it was opened with reached the server, so a
 * reload or a Back before that still lands on the unsaved text, not on an older
 * copy of the row. Esc or "← Inbox" goes back to the page it came from; the
 * draft stays saved in Drafts. A send leaves too, and the shell's undo toast
 * keeps counting down over the page underneath.
 */
import { splitMailtoAddressList } from '@owlat/shared/mailto';
import type { Id } from '@owlat/api/dataModel';
import type { BackendOperationResult } from '~/composables/useBackendOperation';
import {
	composePageKey,
	type ComposeSpec,
} from '~/composables/postbox/usePostboxComposeNav';
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

/** The seed the URL names, or null until the mailbox it needs has loaded. */
function resolveSeed(): ComposeSpec | null {
	const parked = requestKey ? nav.seedFor(requestKey) : null;
	if (parked) return parked;
	const mailboxId = (singleQueryValue(route.query['mailbox']) ?? currentMailbox.value?._id) as
		| Id<'mailboxes'>
		| undefined;
	if (!mailboxId) return null;
	const draftId = singleQueryValue(route.query['draft']);
	if (draftId) return { mailboxId, draftId: draftId as Id<'mailDrafts'> };
	return { mailboxId, ...queryPrefill() };
}

// The composer reads its seed once: resolve it the first time it can be, then
// keep it, so the URL rewrite after the text is saved does not rebuild it.
const seed = ref<ComposeSpec | null>(null);
watchEffect(() => {
	if (!seed.value) seed.value = resolveSeed();
});

// The URL carries text the server may not hold yet (a parked seed, a prefill):
// it only gives way to `&draft=` once that text is confirmed saved.
let urlCarriesText = (!!requestKey && !!nav.seedFor(requestKey)) || queryPrefill() !== null;

const composerRef = ref<{
	flush: () => Promise<BackendOperationResult<Id<'mailDrafts'> | null>>;
	composition: () => ComposeSpec;
} | null>(null);

// Set as the page goes: a save still in flight then must not touch the URL,
// which by now belongs to whatever page came next.
let closed = false;

function nameDraftInUrl(draftId: Id<'mailDrafts'>) {
	if (!seed.value || closed) return;
	if (requestKey) nav.forget(requestKey);
	const alreadyNamed = singleQueryValue(route.query['draft']) === draftId && !urlCarriesText;
	urlCarriesText = false;
	if (alreadyNamed) return;
	// Only the request this page shows: never rewrite another page's URL.
	const current = router.currentRoute.value;
	if (singleQueryValue(current.query['c']) !== requestKey) return;
	void router.replace({
		query: {
			...(requestKey ? { c: requestKey } : {}),
			mailbox: seed.value.mailboxId,
			draft: draftId,
		},
	});
}

let confirming: Promise<void> | null = null;
let confirmAgain = false;
/**
 * Ask the composer to save what is on screen; name the draft once it has. A
 * request that arrives mid-save runs once more afterwards, so a later save is
 * never dropped behind an earlier, failed one.
 */
async function confirmSaved(): Promise<void> {
	if (!urlCarriesText || closed || !composerRef.value) return;
	if (confirming) {
		confirmAgain = true;
		return confirming;
	}
	confirming = (async () => {
		try {
			do {
				confirmAgain = false;
				const saved = await composerRef.value?.flush();
				if (saved?.ok && saved.result) nameDraftInUrl(saved.result);
			} while (confirmAgain && urlCarriesText && !closed);
		} finally {
			confirming = null;
		}
	})();
	return confirming;
}

/**
 * Leaving while the URL still carries text the server may not hold: park what
 * is on screen under this request, then save it. A Back to this request then
 * reopens the newest text, or, once the save lands, the saved draft itself;
 * never the older seed the page was opened with.
 */
function parkOnLeave() {
	closed = true;
	const composer = composerRef.value;
	if (finished || !urlCarriesText || !requestKey || !composer) return;
	const key = requestKey;
	const onScreen: ComposeSpec = {
		...composer.composition(),
		...(seed.value?.replyAllRecipients
			? { replyAllRecipients: seed.value.replyAllRecipients }
			: {}),
	};
	nav.park(key, onScreen);
	void composer.flush().then((saved) => {
		if (saved.ok && saved.result) {
			nav.park(key, { mailboxId: onScreen.mailboxId, draftId: saved.result });
		}
	});
}

// Sent or discarded: the composition is over, and nothing is left to park.
let finished = false;
function finish() {
	finished = true;
	if (requestKey) nav.forget(requestKey);
	leave();
}

function onDraftId(draftId: Id<'mailDrafts'>) {
	if (urlCarriesText) void confirmSaved();
	else nameDraftInUrl(draftId);
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

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => {
	window.removeEventListener('keydown', onKeydown);
	parkOnLeave();
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
					:reply-all-recipients="seed.replyAllRecipients"
					@draft-id="onDraftId"
					@saved="confirmSaved"
					@subject="subject = $event"
					@sent="finish"
					@discarded="finish"
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
