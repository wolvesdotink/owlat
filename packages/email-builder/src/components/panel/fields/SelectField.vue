<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { CheckIcon, ChevronDownIcon } from '@coolicons/vue';
import { useBuilderI18n } from '../../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

const props = defineProps<{
	value: unknown;
	options: { label: string; value: string | number | boolean }[];
	placeholder?: string;
	/** Names the control for assistive tech; the visible label sits outside this component. */
	label?: string;
}>();

const emit = defineEmits<{
	(e: 'update', value: unknown): void;
}>();

const isOpen = ref(false);
const triggerRef = ref<HTMLButtonElement | null>(null);
const wrapperRef = ref<HTMLDivElement | null>(null);
const menuRef = ref<HTMLDivElement | null>(null);

const dropdownStyle = ref<Record<string, string>>({});
const openUpward = ref(false);

const selectedOption = computed(() => {
	return props.options.find((o) => String(o.value) === String(props.value));
});

const selectedLabel = computed(() => {
	return selectedOption.value?.label ?? null;
});

const displayText = computed(() => {
	return selectedLabel.value ?? props.placeholder ?? t('builder.panel.select.placeholder');
});

const hasSelection = computed(() => !!selectedOption.value);

function updatePosition() {
	if (!triggerRef.value) return;
	const rect = triggerRef.value.getBoundingClientRect();
	const gap = 4;
	const menuHeight = 220; // max-h matches this

	const spaceBelow = window.innerHeight - rect.bottom - gap;
	const spaceAbove = rect.top - gap;
	openUpward.value = spaceBelow < menuHeight && spaceAbove > spaceBelow;

	if (openUpward.value) {
		dropdownStyle.value = {
			position: 'fixed',
			left: `${rect.left}px`,
			width: `${rect.width}px`,
			bottom: `${window.innerHeight - rect.top + gap}px`,
			maxHeight: `${Math.min(menuHeight, spaceAbove)}px`,
		};
	} else {
		dropdownStyle.value = {
			position: 'fixed',
			left: `${rect.left}px`,
			width: `${rect.width}px`,
			top: `${rect.bottom + gap}px`,
			maxHeight: `${Math.min(menuHeight, spaceBelow)}px`,
		};
	}
}

function toggle(event?: MouseEvent) {
	isOpen.value = !isOpen.value;
	// detail 0: the click came from Enter or Space, so the list takes focus.
	if (isOpen.value && event?.detail === 0) nextTick(() => focusOption(selectedIndex()));
}

// Keyboard: the trigger opens the list on ↓ ↑ (Enter and Space click it, see
// toggle), focus moves onto the selected option, ↓ ↑ Home End move it, Enter
// or Space picks, and Escape or Tab closes and hands focus back to the trigger. The list is teleported to
// body, so without this Tab from the trigger skipped it entirely.
function optionButtons(): HTMLButtonElement[] {
	return Array.from(menuRef.value?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
}

function focusOption(index: number) {
	const buttons = optionButtons();
	if (buttons.length === 0) return;
	const clamped = Math.max(0, Math.min(index, buttons.length - 1));
	const option = buttons[clamped];
	const menu = menuRef.value;
	if (!option || !menu) return;
	// preventScroll, and the list scrolled by hand: a focus() that scrolled an
	// ancestor would fire the scroll listener that closes the list.
	updatePosition();
	option.focus({ preventScroll: true });
	if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
	else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight)
		menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
}

function selectedIndex(): number {
	const index = props.options.findIndex((o) => String(o.value) === String(props.value));
	return index >= 0 ? index : 0;
}

function openWithKeyboard(event: KeyboardEvent) {
	if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
	event.preventDefault();
	isOpen.value = true;
	nextTick(() => focusOption(selectedIndex()));
}

function close(restoreFocus: boolean) {
	isOpen.value = false;
	if (restoreFocus) triggerRef.value?.focus();
}

function onMenuKeydown(event: KeyboardEvent) {
	const buttons = optionButtons();
	const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
	switch (event.key) {
		case 'ArrowDown':
			event.preventDefault();
			focusOption(current + 1);
			break;
		case 'ArrowUp':
			event.preventDefault();
			focusOption(current - 1);
			break;
		case 'Home':
			event.preventDefault();
			focusOption(0);
			break;
		case 'End':
			event.preventDefault();
			focusOption(buttons.length - 1);
			break;
		case 'Escape':
			event.preventDefault();
			event.stopPropagation();
			close(true);
			break;
		case 'Tab':
			event.preventDefault();
			close(true);
			break;
	}
}

function select(value: unknown) {
	emit('update', value);
	close(true);
}

function handleClickOutside(event: MouseEvent) {
	const target = event.target as Node;
	if (
		wrapperRef.value &&
		!wrapperRef.value.contains(target) &&
		menuRef.value &&
		!menuRef.value.contains(target)
	) {
		isOpen.value = false;
	}
}

function onScrollOrResize(event: Event) {
	// Scrolling the list itself (a long font list) must not close it.
	if (event.type === 'scroll' && menuRef.value?.contains(event.target as Node)) return;
	if (isOpen.value) {
		isOpen.value = false;
	}
}

watch(isOpen, (open) => {
	if (open) {
		nextTick(() => updatePosition());
		window.addEventListener('scroll', onScrollOrResize, true);
		window.addEventListener('resize', onScrollOrResize);
	} else {
		window.removeEventListener('scroll', onScrollOrResize, true);
		window.removeEventListener('resize', onScrollOrResize);
	}
});

onMounted(() => document.addEventListener('click', handleClickOutside));
onUnmounted(() => {
	document.removeEventListener('click', handleClickOutside);
	window.removeEventListener('scroll', onScrollOrResize, true);
	window.removeEventListener('resize', onScrollOrResize);
});
</script>

<template>
	<div ref="wrapperRef" class="relative">
		<button
			ref="triggerRef"
			class="flex items-center justify-between w-full py-2 px-2.5 text-caption pointer-coarse:text-base font-[450] border border-border-strong rounded-lg bg-bg-surface text-text-primary cursor-pointer outline-none text-left gap-1.5 eb-input-ring"
			:class="{ 'border-brand/50 shadow-[0_0_0_3px_rgba(196,120,90,0.08)]': isOpen }"
			type="button"
			:aria-label="label ? `${label}: ${displayText}` : undefined"
			aria-haspopup="listbox"
			:aria-expanded="isOpen"
			@click="toggle"
			@keydown="openWithKeyboard"
		>
			<span
				class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
				:class="{ 'text-text-tertiary': !hasSelection }"
				>{{ displayText }}</span
			>
			<ChevronDownIcon
				:size="14"
				class="text-text-secondary shrink-0 transition-transform duration-(--motion-moderate) ease-spring"
				:class="{ 'rotate-180': isOpen }"
			/>
		</button>

		<Teleport to="body">
			<Transition
				enter-active-class="transition-[opacity,transform] duration-(--motion-moderate) ease-spring"
				leave-active-class="transition-[opacity,transform] duration-(--motion-fast-exit) ease-exit"
				:enter-from-class="openUpward ? 'opacity-0 translate-y-1' : 'opacity-0 -translate-y-1'"
				:leave-to-class="openUpward ? 'opacity-0 translate-y-1' : 'opacity-0 -translate-y-1'"
			>
				<div
					v-if="isOpen"
					ref="menuRef"
					role="listbox"
					:aria-label="label"
					data-eb-popup
					class="z-(--z-menu) p-1 bg-bg-elevated light border border-border-subtle rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.25),0_2px_6px_rgba(0,0,0,0.1)] overflow-y-auto scrollbar-thin"
					:style="dropdownStyle"
					@keydown="onMenuKeydown"
				>
					<button
						v-for="opt in options"
						:key="String(opt.value)"
						class="flex items-center justify-between w-full py-[7px] px-2.5 text-caption text-left border-none rounded-[5px] bg-none text-text-primary cursor-pointer gap-2 transition-[background-color] duration-(--motion-fast) hover:bg-bg-surface-hover focus-visible:outline-none focus-visible:bg-bg-surface-hover focus-visible:shadow-[inset_0_0_0_1px_var(--color-brand)] pointer-coarse:min-h-11"
						:class="{ 'font-medium bg-bg-surface': String(opt.value) === String(value) }"
						type="button"
						role="option"
						tabindex="-1"
						:aria-selected="String(opt.value) === String(value)"
						@click="select(opt.value)"
					>
						<span class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{{
							opt.label
						}}</span>
						<CheckIcon
							v-if="String(opt.value) === String(value)"
							:size="14"
							class="text-brand shrink-0"
						/>
					</button>
				</div>
			</Transition>
		</Teleport>
	</div>
</template>
