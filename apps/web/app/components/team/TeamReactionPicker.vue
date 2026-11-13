<script setup lang="ts">
/**
 * The "add a reaction" button of a team note, with the quick emojis it offers.
 *
 * The list behaves as a menu: opening it moves focus to the first emoji, the
 * arrow keys, Home and End move between them, and Escape, a press outside or
 * focus leaving the picker closes it. Focus inside the picker also keeps the
 * note's hover-revealed action cluster visible while the menu is open.
 */
import { useEscapeLayer } from '@owlat/ui/composables/useEscapeLayer';
import { QUICK_REACTIONS } from '~/utils/teamStream';
import { FaceSmilePlusCornerIcon } from '@coolicons/vue';

const emit = defineEmits<{ pick: [emoji: string] }>();

const { t } = useI18n();
const open = ref(false);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const items = ref<HTMLButtonElement[]>([]);

function close(refocus: boolean) {
	open.value = false;
	if (refocus) trigger.value?.focus();
}

async function toggle() {
	open.value = !open.value;
	if (!open.value) return;
	await nextTick();
	items.value[0]?.focus();
}

function pick(emoji: string) {
	close(true);
	emit('pick', emoji);
}

useEscapeLayer(open, () => close(true));

function onMenuKeydown(event: KeyboardEvent) {
	const count = items.value.length;
	if (count === 0) return;
	const current = items.value.indexOf(document.activeElement as HTMLButtonElement);
	let next: number | null = null;
	if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % count;
	else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
		next = (current - 1 + count) % count;
	else if (event.key === 'Home') next = 0;
	else if (event.key === 'End') next = count - 1;
	if (next === null) return;
	event.preventDefault();
	items.value[next]?.focus();
}

function onFocusOut(event: FocusEvent) {
	const to = event.relatedTarget as Node | null;
	if (open.value && to && !root.value?.contains(to)) close(false);
}

function onPointerDownOutside(event: PointerEvent) {
	if (!root.value?.contains(event.target as Node)) close(false);
}

watch(open, (isOpen) => {
	if (typeof document === 'undefined') return;
	if (isOpen) document.addEventListener('pointerdown', onPointerDownOutside, true);
	else document.removeEventListener('pointerdown', onPointerDownOutside, true);
});

onBeforeUnmount(() => {
	if (typeof document !== 'undefined')
		document.removeEventListener('pointerdown', onPointerDownOutside, true);
});
</script>

<template>
	<span ref="root" class="relative inline-flex" @focusout="onFocusOut">
		<button
			ref="trigger"
			type="button"
			class="reaction-target inline-flex items-center justify-center rounded-full border border-border-subtle px-1.5 py-px text-text-tertiary hover:text-text-primary"
			:aria-label="t('components.team.note.addReaction')"
			aria-haspopup="menu"
			:aria-expanded="open"
			data-testid="team-note-add-reaction"
			@click="toggle"
		>
			<FaceSmilePlusCornerIcon class="size-3.5" aria-hidden="true" />
		</button>
		<span
			v-if="open"
			class="absolute right-0 top-full z-10 mt-1 flex gap-0.5 rounded-lg border border-border-subtle bg-bg-elevated p-1 shadow-md"
			role="menu"
			:aria-label="t('components.team.note.addReaction')"
			@keydown="onMenuKeydown"
		>
			<button
				v-for="emoji in QUICK_REACTIONS"
				:key="emoji"
				ref="items"
				type="button"
				role="menuitem"
				tabindex="-1"
				class="reaction-target inline-flex items-center justify-center rounded px-1.5 py-0.5 text-sm hover:bg-bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				:aria-label="t('components.team.note.reactWith', { emoji })"
				@click="pick(emoji)"
			>
				{{ emoji }}
			</button>
		</span>
	</span>
</template>

<style scoped>
/* A finger needs a 44px target; a mouse keeps the compact chip. */
@media (pointer: coarse) {
	.reaction-target {
		min-width: 44px;
		min-height: 44px;
	}
}
</style>
