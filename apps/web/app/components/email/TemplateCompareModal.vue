<script setup lang="ts">
import type { EditorBlock } from '@owlat/email-builder';
import {
	diffTemplateVersions,
	type BlockChangeKind,
	type FieldChange,
} from '@owlat/email-renderer';

/**
 * Two versions of an email side by side: each rendered with its changed Blocks
 * outlined, then the list of what changed (subject, Blocks, copy, links).
 * Read-only: comparing never writes and never touches the editor. The caller
 * owns where the two versions come from and what can be done with them
 * (the `actions` slot).
 */
export interface CompareSide {
	/** What this side is ("Saved", "Last send", "Now"). */
	label: string;
	/** When or what it is, under the label. */
	detail?: string;
	blocks: EditorBlock[];
	subject: string;
	/** Compared only when both sides carry it. */
	previewText?: string;
}

const props = defineProps<{
	open: boolean;
	/** The older side; null while it loads. */
	before: CompareSide | null;
	after: CompareSide | null;
	loading?: boolean;
}>();

const emit = defineEmits<{ 'update:open': [open: boolean] }>();

const { t } = useI18n();
const { emailTheme } = useEmailTheme();
const { renderBlocksToHtml } = useEmailHtmlRendering();

const KEY = 'components.email.templateCompareModal';

const diff = computed(() => {
	if (!props.open || !props.before || !props.after) return null;
	return diffTemplateVersions(
		{
			blocks: props.before.blocks,
			subject: props.before.subject,
			previewText: props.before.previewText,
		},
		{
			blocks: props.after.blocks,
			subject: props.after.subject,
			previewText: props.after.previewText,
		}
	);
});

// Rendered from the diff's id-normalized trees, so the outline map's ids are
// the ids the renderer sees.
const panes = computed(() => {
	const result = diff.value;
	if (!result || !props.before || !props.after) return [];
	const render = (blocks: EditorBlock[], outlines: Record<string, BlockChangeKind>) =>
		renderBlocksToHtml(blocks, {
			theme: emailTheme.value,
			variableType: 'personalization',
			diffOutlines: outlines,
		});
	return [
		{
			key: 'before',
			side: props.before,
			html: render(result.trees.before, result.outlines.before),
		},
		{ key: 'after', side: props.after, html: render(result.trees.after, result.outlines.after) },
	];
});

const KIND_BADGE: Record<BlockChangeKind, 'success' | 'error' | 'warning' | 'neutral'> = {
	added: 'success',
	removed: 'error',
	edited: 'warning',
	moved: 'neutral',
};

// The outline each kind gets in the previews (`email-renderer` helpers/diffOutline.ts).
const LEGEND: Array<{ kind: BlockChangeKind; swatch: string }> = [
	{ kind: 'added', swatch: 'border-success border-solid' },
	{ kind: 'removed', swatch: 'border-error border-dashed' },
	{ kind: 'edited', swatch: 'border-warning border-double border-[3px]' },
	{ kind: 'moved', swatch: 'border-info border-dotted' },
];

const BLOCK_TYPES = new Set([
	'text',
	'image',
	'button',
	'divider',
	'spacer',
	'columns',
	'social',
	'container',
	'hero',
	'table',
	'rawHtml',
	'video',
	'accordion',
	'menu',
	'carousel',
	'list',
	'progressBar',
]);

const blockTypeLabel = (type: string) =>
	t(`${KEY}.blockTypes.${BLOCK_TYPES.has(type) ? type : 'other'}`);

const kindLabel = (kind: BlockChangeKind) => t(`${KEY}.kinds.${kind}`);

const counts = computed(() => {
	const tally: Record<BlockChangeKind, number> = { added: 0, removed: 0, edited: 0, moved: 0 };
	for (const block of diff.value?.blocks ?? []) tally[block.kind]++;
	return (Object.keys(tally) as BlockChangeKind[])
		.filter((kind) => tally[kind] > 0)
		.map((kind) => ({
			kind,
			label: t(`${KEY}.counts.${kind}`, { count: tally[kind] }, tally[kind]),
		}));
});

/** What changed inside an edited Block, as one short line. */
const partsLabel = (parts: { copy: boolean; links: boolean; other: boolean }, moved: boolean) =>
	[
		parts.copy && t(`${KEY}.parts.copy`),
		parts.links && t(`${KEY}.parts.links`),
		parts.other && t(`${KEY}.parts.other`),
		moved && t(`${KEY}.parts.moved`),
	]
		.filter(Boolean)
		.join(' · ');

const changeKey = (change: FieldChange, index: number) =>
	`${change.blockId}:${change.field}:${change.kind}:${index}`;

const isOpen = computed({
	get: () => props.open,
	set: (open: boolean) => emit('update:open', open),
});
</script>

<template>
	<UiModal v-model:open="isOpen" size="full" :title="t(`${KEY}.title`)">
		<div v-if="loading || !diff" class="h-[60vh] flex items-center justify-center">
			<UiSpinner />
		</div>

		<div v-else class="space-y-4" data-testid="template-compare">
			<div class="flex flex-wrap items-center gap-2">
				<p v-if="diff.identical" class="text-sm text-text-secondary">
					{{ t(`${KEY}.identical`) }}
				</p>
				<UiBadge
					v-for="count in counts"
					:key="count.kind"
					:variant="KIND_BADGE[count.kind]"
					size="md"
				>
					{{ count.label }}
				</UiBadge>
				<span v-if="!diff.identical" class="flex flex-wrap items-center gap-3 sm:ml-auto">
					<span
						v-for="entry in LEGEND"
						:key="entry.kind"
						class="flex items-center gap-1.5 text-xs text-text-tertiary"
					>
						<span class="inline-block h-3 w-4 rounded-sm border-2" :class="entry.swatch" />
						{{ kindLabel(entry.kind) }}
					</span>
				</span>
			</div>

			<dl v-if="diff.meta.length" class="space-y-1 text-sm">
				<div v-for="change in diff.meta" :key="change.field" class="flex flex-wrap gap-x-2">
					<dt class="text-text-secondary">{{ t(`${KEY}.meta.${change.field}`) }}</dt>
					<dd class="min-w-0 break-words">
						<del class="text-error">{{ change.before || t(`${KEY}.empty`) }}</del>
						<span class="text-text-tertiary" aria-hidden="true"> → </span>
						<ins class="text-success no-underline">{{ change.after || t(`${KEY}.empty`) }}</ins>
					</dd>
				</div>
			</dl>

			<div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
				<section v-for="pane in panes" :key="pane.key" class="min-w-0">
					<header class="mb-1.5 flex items-baseline gap-2">
						<h3 class="text-sm font-medium text-text-primary">{{ pane.side.label }}</h3>
						<span v-if="pane.side.detail" class="truncate text-xs text-text-tertiary">
							{{ pane.side.detail }}
						</span>
					</header>
					<!-- palette-ok-start: the paper stays literally white in both app themes, as in
					     the history preview: the email's own HTML carries its (light) colors. -->
					<iframe
						:srcdoc="pane.html"
						sandbox=""
						:title="t(`${KEY}.frameTitle`, { side: pane.side.label })"
						class="h-[45vh] w-full rounded-lg border border-border-subtle bg-white"
					/>
					<!-- palette-ok-end -->
				</section>
			</div>

			<template v-if="!diff.identical">
				<section v-if="diff.blocks.length">
					<h3 class="mb-1.5 text-sm font-medium text-text-primary">{{ t(`${KEY}.blocks`) }}</h3>
					<ul class="divide-y divide-border-subtle rounded-lg border border-border-subtle">
						<li
							v-for="block in diff.blocks"
							:key="`${block.kind}:${block.id}`"
							class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm"
						>
							<UiBadge :variant="KIND_BADGE[block.kind]">{{ kindLabel(block.kind) }}</UiBadge>
							<span class="text-text-primary">{{ blockTypeLabel(block.type) }}</span>
							<span v-if="block.excerpt" class="min-w-0 truncate text-text-tertiary">
								{{ block.excerpt }}
							</span>
							<span v-if="block.kind === 'edited'" class="text-xs text-text-tertiary sm:ml-auto">
								{{ partsLabel(block.parts, block.moved) }}
							</span>
						</li>
					</ul>
				</section>

				<section v-for="group in ['copy', 'links'] as const" :key="group">
					<h3 class="mb-1.5 text-sm font-medium text-text-primary">
						{{ t(`${KEY}.${group}Changes`) }}
					</h3>
					<p v-if="!diff[group].length" class="text-sm text-text-tertiary">
						{{ t(`${KEY}.${group}None`) }}
					</p>
					<ul v-else class="space-y-2">
						<li
							v-for="(change, index) in diff[group]"
							:key="changeKey(change, index)"
							class="rounded-lg bg-bg-surface px-3 py-2 text-sm"
						>
							<p class="text-xs text-text-tertiary">
								{{ blockTypeLabel(change.blockType) }} · {{ t(`${KEY}.steps.${change.kind}`) }}
							</p>
							<p v-if="change.kind !== 'added'" class="mt-0.5 break-words">
								<del class="text-error">{{ change.before }}</del>
							</p>
							<p v-if="change.kind !== 'removed'" class="mt-0.5 break-words">
								<ins class="text-success no-underline">{{ change.after }}</ins>
							</p>
						</li>
					</ul>
				</section>
			</template>
		</div>

		<template #footer>
			<UiButton variant="secondary" @click="isOpen = false">{{ t('common.close') }}</UiButton>
			<slot name="actions" />
		</template>
	</UiModal>
</template>
