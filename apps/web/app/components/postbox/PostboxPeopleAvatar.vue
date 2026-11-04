<script setup lang="ts">
/**
 * The People view's mark for whoever a row or page is about. The two shapes
 * are the point: a person is a round avatar in their identity colour, a
 * company is a square tile tinted in its colour (its logo when its mail proved
 * the domain, else its initial), and an automated sender is an outlined tile
 * with what it sends drawn in it (a newspaper, a receipt, a tag, a bell for
 * notifications, a page for anything else),
 * or its logo; not the robot, which marks the AI team inbox.
 * They are meant to be told apart in a fast scroll without reading a word.
 * Decorative: the name beside it is the accessible label.
 */
import { AVATAR_COLOR_STYLES, initialsAndColorForAddress } from '~/utils/avatar';
import { BellIcon, FileTextIcon, NewspaperIcon, ReceiptIcon, TagIcon } from '@coolicons/vue';

type Size = 'sm' | 'md' | 'lg' | 'xl';

const props = withDefaults(
	defineProps<{
		kind: 'person' | 'company';
		name: string;
		/** Colour key for a person (their address), so a renamed contact keeps its colour. */
		colorKey?: string;
		logoUrl?: string;
		/** An automated sender: the bell sets it apart from a company of people. */
		isAutomated?: boolean;
		/** What an automated sender sends most, for its tile's glyph. */
		senderKind?: string | null;
		size?: Size;
	}>(),
	{ colorKey: undefined, logoUrl: undefined, isAutomated: false, senderKind: null, size: 'md' }
);
const BADGE: Record<Size, string> = {
	sm: 'hidden',
	md: 'w-4 h-4 -right-1 -bottom-1 rounded-[5px]',
	lg: 'w-5 h-5 -right-1 -bottom-1 rounded-md',
	xl: 'w-6 h-6 -right-1.5 -bottom-1.5 rounded-lg',
};

const SIZE: Record<Size, string> = {
	sm: 'w-6 h-6 text-[10px]',
	md: 'w-9 h-9 text-xs',
	lg: 'w-12 h-12 text-sm',
	xl: 'w-16 h-16 text-xl',
};
const COMPANY_RADIUS: Record<Size, string> = {
	sm: 'rounded-[5px]',
	md: 'rounded-lg',
	lg: 'rounded-xl',
	xl: 'rounded-2xl',
};

const failedLogo = ref<string | null>(null);
const logo = computed(() =>
	props.logoUrl && props.logoUrl !== failedLogo.value ? props.logoUrl : null
);

const identity = computed(() =>
	initialsAndColorForAddress(props.name || props.colorKey || '?', {
		colorKey: props.colorKey,
	})
);
const personStyle = computed(() => AVATAR_COLOR_STYLES[identity.value.colorToken]);
const companyInitial = computed(() => (props.name.trim()[0] ?? '?').toUpperCase());
// A soft tint of the company's identity colour, so a monogram reads as a mark
// and not as a logo that failed to load.
const senderGlyph = computed(() =>
	props.senderKind === 'newsletter'
		? NewspaperIcon
		: props.senderKind === 'receipt'
			? ReceiptIcon
			: props.senderKind === 'promotion'
				? TagIcon
				: props.senderKind === 'notification'
					? BellIcon
					: FileTextIcon
);
const isSenderTile = computed(() => props.kind === 'company' && props.isAutomated && !logo.value);
const companyStyle = computed(() => {
	if (logo.value || isSenderTile.value) return undefined;
	const ink = AVATAR_COLOR_STYLES[identity.value.colorToken].background;
	return {
		// Mixed toward the page's own ink, so the letter holds its contrast on a
		// dark surface as well as a light one.
		background: `color-mix(in srgb, ${ink} 22%, var(--color-bg-surface))`,
		color: `color-mix(in srgb, ${ink} 45%, var(--color-text-primary))`,
	};
});
</script>

<template>
	<span class="relative inline-flex flex-shrink-0" aria-hidden="true">
		<span
			v-if="kind === 'person'"
			class="flex items-center justify-center rounded-full font-semibold tracking-tight select-none"
			:class="SIZE[size]"
			:style="personStyle"
			>{{ identity.initials }}</span
		>
		<!-- palette-ok: logos are drawn for a white ground in both themes -->
		<span
			v-else
			class="flex items-center justify-center overflow-hidden font-bold tracking-tight select-none"
			:class="[
				SIZE[size],
				COMPANY_RADIUS[size],
				isSenderTile
					? 'border border-border-strong text-text-secondary'
					: 'ring-1 ring-inset ring-border-default',
				logo ? 'bg-white' : '',
			]"
			:style="companyStyle"
		>
			<component :is="senderGlyph" v-if="isSenderTile" class="h-[55%] w-[55%]" />
			<img
				v-if="logo"
				:src="logo"
				alt=""
				class="h-full w-full object-contain p-[12%]"
				decoding="async"
				@error="failedLogo = logo"
			/>
			<span v-else-if="!isSenderTile">{{ companyInitial }}</span>
		</span>
		<span
			v-if="kind === 'company' && isAutomated && !isSenderTile"
			class="absolute flex items-center justify-center bg-bg-overlay text-text-secondary shadow-surface-2"
			:class="BADGE[size]"
		>
			<BellIcon class="h-[70%] w-[70%]" />
		</span>
	</span>
</template>
