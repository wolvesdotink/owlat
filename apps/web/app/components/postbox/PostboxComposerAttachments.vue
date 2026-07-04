<script setup lang="ts">
import type { UploadChip } from '~/composables/postbox/postboxAttachmentUploads';
import type { AttachmentMeter } from '~/composables/postbox/postboxAttachmentMeter';

/** A committed attachment (already uploaded, has a storageId). */
interface ComposerAttachment {
	storageId: string;
	filename: string;
	contentType: string;
	size: number;
}

defineProps<{
	/** Committed attachments (uploaded, graduated out of the upload chips). */
	attachments: ComposerAttachment[];
	/** In-flight / failed upload chips (no storageId yet). */
	uploads: UploadChip[];
	/** Total-size meter state; only rendered when `visible`. */
	meter: AttachmentMeter;
	/** Resolve a committed attachment's image thumbnail object URL, if any. */
	thumbUrlFor: (storageId: string) => string | null;
}>();

const emit = defineEmits<{
	(e: 'remove', storageId: string): void;
	(e: 'cancel', id: string): void;
	(e: 'retry', id: string): void;
}>();
</script>

<template>
	<div
		v-if="attachments.length > 0 || uploads.length > 0"
		class="px-3 py-2 border-t border-border-subtle flex flex-col gap-2"
	>
		<div class="flex flex-wrap gap-2">
			<!-- Committed attachments -->
			<span
				v-for="att in attachments"
				:key="att.storageId"
				class="inline-flex items-center gap-1.5 pl-1.5 pr-1 py-1 rounded bg-bg-surface text-xs"
			>
				<img
					v-if="thumbUrlFor(att.storageId)"
					:src="thumbUrlFor(att.storageId) || ''"
					:alt="att.filename"
					class="w-5 h-5 rounded object-cover"
				/>
				<Icon v-else name="lucide:paperclip" class="w-3 h-3 text-text-tertiary" />
				<span class="truncate max-w-[140px]">{{ att.filename }}</span>
				<span class="text-text-tertiary">{{ formatCompactFileSize(att.size) }}</span>
				<button
					type="button"
					class="p-0.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary"
					:aria-label="`Remove ${att.filename}`"
					@click="emit('remove', att.storageId)"
				>
					<Icon name="lucide:x" class="w-3 h-3" />
				</button>
			</span>

			<!-- In-flight / failed uploads -->
			<span
				v-for="up in uploads"
				:key="up.id"
				class="relative inline-flex items-center gap-1.5 pl-1.5 pr-1 py-1 rounded bg-bg-surface text-xs overflow-hidden"
				:class="up.status === 'failed' ? 'ring-1 ring-red-500/50' : ''"
			>
				<img
					v-if="up.thumbUrl"
					:src="up.thumbUrl"
					:alt="up.filename"
					class="w-5 h-5 rounded object-cover"
				/>
				<Icon
					v-else
					:name="up.status === 'failed' ? 'lucide:alert-circle' : 'lucide:paperclip'"
					class="w-3 h-3"
					:class="up.status === 'failed' ? 'text-red-500' : 'text-text-tertiary'"
				/>
				<span class="truncate max-w-[140px]">{{ up.filename }}</span>
				<span v-if="up.status === 'failed'" class="text-red-500">Failed</span>
				<span v-else class="text-text-tertiary tabular-nums">
					{{ up.indeterminate ? '…' : Math.round(up.progress * 100) + '%' }}
				</span>
				<button
					v-if="up.status === 'failed'"
					type="button"
					class="p-0.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary"
					:aria-label="`Retry ${up.filename}`"
					title="Retry upload"
					@click="emit('retry', up.id)"
				>
					<Icon name="lucide:rotate-cw" class="w-3 h-3" />
				</button>
				<button
					type="button"
					class="p-0.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary"
					:aria-label="up.status === 'failed' ? `Dismiss ${up.filename}` : `Cancel ${up.filename}`"
					@click="emit('cancel', up.id)"
				>
					<Icon name="lucide:x" class="w-3 h-3" />
				</button>
				<!-- Progress bar: determinate width, or an indeterminate shimmer -->
				<span
					v-if="up.status === 'uploading'"
					class="absolute inset-x-0 bottom-0 h-0.5 bg-bg-elevated"
					aria-hidden="true"
				>
					<span
						class="block h-full bg-accent transition-[width] duration-(--motion-moderate)"
						:class="up.indeterminate ? 'w-full animate-pulse' : ''"
						:style="up.indeterminate ? undefined : { width: Math.round(up.progress * 100) + '%' }"
					/>
				</span>
			</span>
		</div>

		<!-- Total-size meter: appears past ~50% of the per-message budget. -->
		<div v-if="meter.visible" class="flex flex-col gap-1">
			<div class="flex items-center justify-between text-[11px]">
				<span
					class="h-1 flex-1 mr-2 rounded-full bg-bg-elevated overflow-hidden"
					aria-hidden="true"
				>
					<span
						class="block h-full rounded-full transition-[width] duration-(--motion-moderate)"
						:class="meter.amber ? 'bg-amber-500' : 'bg-accent'"
						:style="{ width: Math.min(100, Math.round(meter.ratio * 100)) + '%' }"
					/>
				</span>
				<span
					class="tabular-nums shrink-0"
					:class="meter.amber ? 'text-amber-500' : 'text-text-tertiary'"
				>
					{{ formatCompactFileSize(meter.totalBytes) }}
					of {{ formatCompactFileSize(meter.budgetBytes) }}
				</span>
			</div>
			<p v-if="meter.amber" class="text-[11px] text-amber-500">
				Large attachments may bounce — consider sharing a link for oversized files.
			</p>
		</div>
	</div>
</template>
