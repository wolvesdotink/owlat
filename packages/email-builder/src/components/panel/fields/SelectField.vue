<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { ChevronDown, Check } from '@lucide/vue';

const props = defineProps<{
	value: unknown;
	options: { label: string; value: string | number | boolean }[];
	placeholder?: string;
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
	return selectedLabel.value ?? props.placeholder ?? 'Choose...';
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

function toggle() {
	isOpen.value = !isOpen.value;
}

function select(value: unknown) {
	emit('update', value);
	isOpen.value = false;
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

function onScrollOrResize() {
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
			class="flex items-center justify-between w-full py-2 px-2.5 text-[13px] font-[450] border border-border-subtle rounded-lg bg-bg-surface text-text-primary cursor-pointer outline-none text-left gap-1.5 eb-input-ring"
			:class="{ 'border-brand/50 shadow-[0_0_0_3px_rgba(196,120,90,0.08)]': isOpen }"
			type="button"
			@click="toggle"
		>
			<span
				class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
				:class="{ 'text-text-tertiary': !hasSelection }"
				>{{ displayText }}</span
			>
			<ChevronDown
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
					class="z-[9999] p-1 bg-bg-elevated light border border-border-subtle rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.25),0_2px_6px_rgba(0,0,0,0.1)] overflow-y-auto scrollbar-thin"
					:style="dropdownStyle"
				>
					<button
						v-for="opt in options"
						:key="String(opt.value)"
						class="flex items-center justify-between w-full py-[7px] px-2.5 text-[13px] text-left border-none rounded-[5px] bg-none text-text-primary cursor-pointer gap-2 transition-[background-color] duration-(--motion-fast) hover:bg-bg-surface-hover"
						:class="{ 'text-brand font-medium bg-bg-surface': String(opt.value) === String(value) }"
						type="button"
						@click="select(opt.value)"
					>
						<span class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{{
							opt.label
						}}</span>
						<Check
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
