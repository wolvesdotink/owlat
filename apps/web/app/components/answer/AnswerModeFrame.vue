<script setup lang="ts">
/**
 * Answer mode's frame: one reply, the whole screen (plan §02, §04, §08).
 *
 * A top bar ("← Inbox" with its Esc hint, the subject and message count, and
 * three slots the page fills: who the reply goes out as, queue navigation, a ⋯
 * menu) over a body of two columns, the conversation and the composer.
 *
 * Three layouts by width (rules in `utils/answerModeLayout.ts`):
 *   - from 1100px: side by side, conversation ~52%, composer ~48%;
 *   - 768–1100px: stacked, the conversation scrolls and the composer is a
 *     sheet along the bottom that grows with the draft;
 *   - below 768px: two tabs, Conversation and Reply, under a compact top bar.
 *     The reply is a sheet: it waits at the bottom of the Conversation tab as
 *     one "Reply to Jonas…" row, rises over the conversation so the email stays
 *     in view while typing, and fills the screen as the Reply tab.
 * Below 1100px the sheet's handle drags (with a flick to the next height), and
 * as a button it toggles and takes the arrow keys, so every height is reachable
 * without a pointer.
 *
 * Both columns stay mounted in every layout and every sheet height: switching
 * a tab on a phone must not throw away the draft being typed.
 *
 * The frame's height leaves out the on-screen keyboard (`useKeyboardInset`),
 * and its bottom edge the home indicator, so Send stays reachable on a phone.
 * The mobile tab bar is not here at all: Answer mode is a focus-mode page, and
 * the shell unmounts its chrome, tab bar included, while one is open.
 */
import { useAnswerLayout, useAnswerSheet } from '~/composables/useAnswerSheet';
import { useAnswerAnchor } from '~/composables/useAnswerAnchor';
import { useKeyboardInset } from '~/composables/useKeyboardInset';
import type { AnswerSheetState, AnswerTab } from '~/utils/answerModeLayout';
import { pushShortcutScope } from '~/utils/shortcutScope';

const props = defineProps<{
	/** Where "←" goes, spelled as a place ("Inbox", "Answer queue"). */
	backLabel: string;
	subject: string;
	/** Messages in the conversation; omitted while it loads. */
	messageCount?: number;
	/** A short line after the count: the correspondent. */
	counterpart?: string;
	/** Where the correspondent's name leads (their contact profile), if anywhere. */
	counterpartTo?: string;
	/**
	 * The resting sheet's row, when the reply waits on something other than
	 * writing ("Answer the questions for this reply…"). Otherwise "Reply to …".
	 */
	peekText?: string;
}>();

const emit = defineEmits<{
	back: [];
	/**
	 * "Reply to Jonas…" was tapped and the composer is showing: the page puts
	 * the caret in the body through the composer (a DOM query here would find
	 * the folded envelope's inputs, or the AI bar's, before the editor).
	 * Emitted inside the tap, so the page's focus is too.
	 */
	'start-reply': [];
}>();

/** The phone layout's open tab. The page switches it (Cmd/Ctrl+J opens Reply). */
const tab = defineModel<AnswerTab>('tab', { default: 'conversation' });

const { t } = useI18n();

/** The meta line before the correspondent: "5 messages · ", or just the count. */
const metaPrefix = computed(() => {
	if (props.messageCount === undefined) return '';
	const count = t(
		'components.answer.mode.messageCount',
		{ count: props.messageCount },
		props.messageCount
	);
	return props.counterpart ? `${count} · ` : count;
});

// Answer mode's keys (Esc, t, Cmd/Ctrl+J, 1 to 9, [ and ]) are bound by the
// pages and the ask card; claiming the scope puts them on the "?" sheet, in
// place of the app-wide Esc they replace here.
let releaseScope: (() => void) | null = null;
onMounted(() => {
	releaseScope = pushShortcutScope('answer');
});
onBeforeUnmount(() => releaseScope?.());

const conversationPanelId = useId();
const replyPanelId = useId();
const sheetHintId = useId();

const layout = useAnswerLayout();
// On a phone or tablet, open with the message being answered in view.
const conversationEl = ref<HTMLElement | null>(null);
useAnswerAnchor({ column: conversationEl, active: () => layout.value !== 'split' });
const keyboard = useKeyboardInset();
const bodyEl = ref<HTMLElement | null>(null);
const sheetEl = ref<HTMLElement | null>(null);
const handleEl = ref<HTMLElement | null>(null);
const contentEl = ref<HTMLElement | null>(null);

const sheet = useAnswerSheet({ tab, layout, body: bodyEl, sheet: sheetEl, handle: handleEl });
const isSheet = computed(() => layout.value !== 'split');
const dragging = computed(() => sheet.dragHeight.value !== null);

/** On a phone the full sheet is the Reply tab: the conversation steps out. */
const conversationHidden = computed(
	() => layout.value === 'phone' && sheet.state.value === 'full' && !dragging.value
);
/** A peeking sheet is only its handle row; the composer waits, mounted. */
const composerHidden = computed(
	() => isSheet.value && sheet.state.value === 'peek' && !dragging.value
);

const SHEET_HEIGHT: Record<'phone' | 'stacked', Record<AnswerSheetState, string>> = {
	phone: { peek: 'shrink-0', half: 'h-[55%] shrink-0', full: 'min-h-0 flex-1' },
	// The resting tablet sheet sizes to the draft between a floor and a cap.
	stacked: { peek: 'shrink-0', half: 'min-h-56 max-h-[60%] shrink-0', full: 'h-[85%] shrink-0' },
};

const sheetClass = computed(() => {
	if (layout.value === 'split') return 'min-h-0 basis-[48%] border-l';
	const height = dragging.value ? 'shrink-0' : SHEET_HEIGHT[layout.value][sheet.state.value];
	const flush = layout.value === 'phone' && sheet.state.value === 'full' && !dragging.value;
	return [
		height,
		flush ? '' : 'rounded-t-xl border-t shadow-lg',
		dragging.value
			? ''
			: 'transition-[height] duration-(--motion-moderate) motion-reduce:transition-none',
	];
});

const sheetStyle = computed(() =>
	sheet.dragHeight.value === null ? undefined : { height: `${sheet.dragHeight.value}px` }
);

const frameStyle = computed(() => ({
	'--answer-keyboard-inset': `${keyboard.value}px`,
	// The home indicator sits under the keyboard while one is open.
	'--answer-bottom-inset': keyboard.value > 0 ? '0px' : 'env(safe-area-inset-bottom, 0px)',
}));

const handleLabel = computed(() => {
	const next =
		sheet.state.value === 'peek' ? 'raise' : sheet.state.value === 'half' ? 'lower' : 'shrink';
	return t(`components.answer.mode.sheet.${next}`);
});

const peekLabel = computed(() => {
	if (props.peekText) return props.peekText;
	return props.counterpart
		? t('components.answer.mode.sheet.peek', { name: props.counterpart })
		: t('components.answer.mode.sheet.peekNoName');
});

/**
 * "Reply to Jonas…": raise the sheet to where the email stays in view, and put
 * the caret in the reply so the keyboard comes up with it.
 *
 * iOS raises the keyboard only for a focus made in the tap's own task, and a
 * `display: none` editor takes no focus at all. So the composer is shown now,
 * by hand, rather than on the next render; the render then agrees (a half
 * sheet shows its composer) and the inline style is dropped.
 */
function startReply() {
	sheet.set('half');
	const content = contentEl.value;
	if (content) {
		content.style.display = 'flex';
		content.removeAttribute('data-sheet-hidden');
	}
	emit('start-reply');
	void nextTick(() => {
		if (content) content.style.display = '';
	});
}
</script>

<template>
	<div
		class="flex h-[calc(100dvh-var(--titlebar-h,0px)-var(--answer-keyboard-inset,0px))] flex-col bg-bg-base pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)]"
		:style="frameStyle"
		:data-layout="layout"
		data-testid="answer-mode"
	>
		<header
			class="flex items-center gap-3 border-b border-border-subtle bg-bg-elevated px-3 py-2 pt-[calc(env(safe-area-inset-top,0px)+0.5rem)] md:px-4"
		>
			<button
				type="button"
				class="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-text-secondary hover:bg-bg-surface hover:text-text-primary focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
				:aria-label="t('components.answer.mode.back', { page: backLabel })"
				data-testid="answer-back"
				@click="emit('back')"
			>
				<Icon name="lucide:arrow-left" class="size-4" />
				<span class="max-md:hidden">{{ backLabel }}</span>
				<!-- A key hint means nothing without a keyboard. -->
				<kbd class="font-mono text-2xs text-text-tertiary max-md:hidden pointer-coarse:hidden">
					Esc
				</kbd>
			</button>
			<div class="min-w-0 flex-1">
				<h1 class="truncate text-sm font-medium text-text-primary" data-testid="answer-subject">
					{{ subject || t('components.shell.noSubject') }}
				</h1>
				<!-- The phone's bar stays one line: back, subject, queue position.
				     The sheet's "Reply to …" row names the correspondent. -->
				<p
					v-if="(metaPrefix || counterpart) && layout !== 'phone'"
					class="truncate text-xs text-text-tertiary"
					data-testid="answer-meta"
				>
					{{ metaPrefix
					}}<NuxtLink
						v-if="counterpart && counterpartTo"
						:to="counterpartTo"
						class="hover:text-text-primary hover:underline"
						data-testid="answer-counterpart"
						>{{ counterpart }}</NuxtLink
					><template v-else-if="counterpart">{{ counterpart }}</template>
				</p>
			</div>
			<div class="hidden min-w-0 lg:flex">
				<slot name="identity" />
			</div>
			<slot name="queue" />
			<slot name="menu" />
		</header>

		<div
			v-if="layout === 'phone'"
			role="tablist"
			:aria-label="t('components.answer.mode.tabsLabel')"
			class="flex border-b border-border-subtle bg-bg-elevated"
		>
			<button
				v-for="item in ['conversation', 'reply'] as const"
				:key="item"
				type="button"
				role="tab"
				:aria-selected="tab === item"
				:aria-controls="item === 'conversation' ? conversationPanelId : replyPanelId"
				class="flex-1 border-b-2 px-3 py-2.5 text-sm font-medium"
				:class="
					tab === item
						? 'border-brand text-text-primary'
						: 'border-transparent text-text-tertiary hover:text-text-primary'
				"
				:data-testid="`answer-tab-${item}`"
				@click="tab = item"
			>
				{{ t(`components.answer.mode.tabs.${item}`) }}
			</button>
		</div>

		<div
			ref="bodyEl"
			class="flex min-h-0 flex-1"
			:class="layout === 'split' ? 'flex-row' : 'flex-col'"
		>
			<section
				:id="conversationPanelId"
				ref="conversationEl"
				class="min-h-0 flex-1 overflow-y-auto"
				:class="[
					{ hidden: conversationHidden },
					layout === 'split' ? 'basis-[52%] pb-(--answer-bottom-inset)' : '',
				]"
				:aria-label="t('components.answer.mode.tabs.conversation')"
				data-testid="answer-conversation-column"
			>
				<slot name="conversation" :layout="layout" />
			</section>
			<section
				:id="replyPanelId"
				ref="sheetEl"
				class="flex flex-col overflow-hidden border-border-subtle bg-bg-elevated pb-(--answer-bottom-inset)"
				:class="sheetClass"
				:style="sheetStyle"
				:aria-label="t('components.answer.mode.tabs.reply')"
				:data-sheet-state="isSheet ? sheet.state.value : undefined"
				data-testid="answer-composer-column"
			>
				<div
					v-if="isSheet"
					ref="handleEl"
					class="shrink-0 touch-none select-none"
					data-testid="answer-sheet-handle-row"
					@pointerdown="sheet.onPointerDown"
					@pointermove="sheet.onPointerMove"
					@pointerup="sheet.onPointerUp"
					@pointercancel="sheet.onPointerCancel"
					@click.capture="sheet.onClickCapture"
				>
					<button
						type="button"
						class="group flex h-6 w-full cursor-grab items-center justify-center outline-none active:cursor-grabbing"
						:aria-label="handleLabel"
						:aria-expanded="sheet.state.value !== 'peek'"
						:aria-controls="replyPanelId"
						:aria-describedby="sheetHintId"
						aria-keyshortcuts="ArrowUp ArrowDown"
						data-testid="answer-sheet-handle"
						@click="sheet.onHandleClick"
						@keydown="sheet.onHandleKeydown"
					>
						<span
							class="h-1 w-10 rounded-full bg-border-strong group-focus-visible:ring-2 group-focus-visible:ring-brand group-focus-visible:ring-offset-2"
							aria-hidden="true"
						/>
					</button>
					<span :id="sheetHintId" class="sr-only">{{
						t('components.answer.mode.sheet.hint')
					}}</span>
					<div v-if="sheet.state.value === 'peek'" class="flex items-center gap-2 px-3 pb-2.5">
						<!-- Waiting on something (peekText) it reads as the next step,
						     not as an empty field. -->
						<button
							type="button"
							class="min-w-0 flex-1 truncate rounded-md border px-3 py-2 text-left text-sm"
							:class="
								peekText
									? 'border-brand/30 bg-brand/5 font-medium text-text-primary hover:bg-brand/10'
									: 'border-border-subtle bg-bg-base text-text-tertiary hover:text-text-primary'
							"
							data-testid="answer-sheet-peek"
							@click="startReply"
						>
							{{ peekLabel }}
						</button>
						<!-- The AI entry ("✦ Draft") beside the resting reply. -->
						<slot name="peek-actions" />
					</div>
				</div>
				<!-- `data-sheet-hidden`: what is in the composer stands down its
				     window-wide keys while it is out of sight (AskCard's 1 to 9). -->
				<div
					ref="contentEl"
					class="min-h-0 flex-1 flex-col"
					:class="composerHidden ? 'hidden' : 'flex'"
					:data-sheet-hidden="composerHidden ? '' : undefined"
					data-testid="answer-composer-content"
				>
					<slot name="composer" />
				</div>
			</section>
		</div>
	</div>
</template>
