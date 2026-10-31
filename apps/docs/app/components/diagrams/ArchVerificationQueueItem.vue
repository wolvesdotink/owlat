<script setup lang="ts">
/**
 * One row of the `ArchVerificationQueue` list: confidence bar, summary and the
 * review actions (or the auto-approved badge).
 *
 * The entrance and attention rules key off the parent's `.is-visible`; scoped CSS only
 * scopes the last selector part, so that ancestor class still matches.
 */
import type { QueueItem } from '../../utils/diagrams/archVerificationQueue';

defineProps<{
	item: QueueItem;
	/** Position in the list; drives the entrance stagger. */
	index: number;
}>();
</script>

<template>
	<div
		class="vq-item"
		:class="[`vq-item--${item.confidenceLevel}`, { 'is-auto': item.status === 'auto-approved' }]"
		:style="{ '--i': index }"
	>
		<!-- Left: confidence bar -->
		<div class="vq-item-confidence">
			<div class="vq-confidence-bar">
				<div
					class="vq-confidence-fill"
					:class="`vq-confidence-fill--${item.confidenceLevel}`"
					:style="{ height: `${item.confidence}%` }"
				/>
			</div>
			<span class="vq-confidence-num" :class="`vq-confidence-num--${item.confidenceLevel}`"
				>{{ item.confidence }}%</span
			>
		</div>

		<!-- Center: content -->
		<div class="vq-item-content">
			<div class="vq-item-top">
				<div class="vq-item-type">
					<svg
						width="12"
						height="12"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path :d="item.icon" />
					</svg>
					<span>{{ item.typeLabel }}</span>
				</div>
				<span class="vq-item-time">{{ item.time }}</span>
			</div>
			<span class="vq-item-subject">{{ item.subject }}</span>
			<span class="vq-item-from">from {{ item.from }}</span>
		</div>

		<!-- Right: actions -->
		<div class="vq-item-actions">
			<template v-if="item.status === 'auto-approved'">
				<div class="vq-auto-badge">
					<svg
						width="12"
						height="12"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M5 13l4 4L19 7" />
					</svg>
					<span>Auto-approved</span>
				</div>
			</template>
			<template v-else>
				<UiTooltip text="Approve">
					<button class="vq-action vq-action--approve" aria-label="Approve">
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="M5 13l4 4L19 7" />
						</svg>
					</button>
				</UiTooltip>
				<UiTooltip text="Edit">
					<button class="vq-action vq-action--edit" aria-label="Edit">
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path
								d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
							/>
						</svg>
					</button>
				</UiTooltip>
				<UiTooltip text="Reject">
					<button class="vq-action vq-action--reject" aria-label="Reject">
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</UiTooltip>
			</template>
		</div>
	</div>
</template>

<style scoped>
/* ── Queue item ── */
.vq-item {
	display: flex;
	align-items: center;
	gap: 14px;
	padding: 12px 14px;
	border-radius: 10px;
	background: var(--color-bg-elevated);
	border: 1px solid var(--color-border-default);
	opacity: 0;
	transform: translateX(-8px);
	transition:
		opacity 0.45s var(--ease-spring),
		transform 0.45s var(--ease-spring),
		border-color var(--motion-moderate),
		box-shadow var(--motion-moderate);
	transition-delay: calc(0.15s + var(--i) * 0.08s);
}

.is-visible .vq-item {
	opacity: 1;
	transform: translateX(0);
}

.vq-item:hover {
	border-color: var(--color-border-strong);
	box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
	transition-delay: 0s;
}

.vq-item.is-auto {
	opacity: 0;
	border-color: color-mix(in oklab, var(--color-success) 15%, var(--color-border-default));
	background: color-mix(in oklab, var(--color-success) 2%, var(--color-bg-elevated));
}

.is-visible .vq-item.is-auto {
	opacity: 0.7;
}

.vq-item.is-auto:hover {
	opacity: 1;
}

/* ── Confidence indicator ── */
.vq-item-confidence {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 4px;
	flex-shrink: 0;
	width: 32px;
}

.vq-confidence-bar {
	width: 4px;
	height: 32px;
	border-radius: 2px;
	background: var(--color-bg-surface);
	position: relative;
	overflow: hidden;
}

.vq-confidence-fill {
	position: absolute;
	bottom: 0;
	left: 0;
	right: 0;
	border-radius: 2px;
	transition: height 0.6s var(--ease-spring);
}

.vq-confidence-fill--high {
	background: var(--color-success);
}
.vq-confidence-fill--medium {
	background: var(--color-warning);
}
.vq-confidence-fill--low {
	background: var(--color-error);
}

.vq-confidence-num {
	font-size: 0.625rem;
	font-weight: 700;
	font-family: var(--font-mono);
}

.vq-confidence-num--high {
	color: var(--color-success);
}
.vq-confidence-num--medium {
	color: var(--color-warning);
}
.vq-confidence-num--low {
	color: var(--color-error);
}

/* ── Item content ── */
.vq-item-content {
	flex: 1;
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}

.vq-item-top {
	display: flex;
	align-items: center;
	gap: 8px;
}

.vq-item-type {
	display: flex;
	align-items: center;
	gap: 4px;
	font-size: 0.625rem;
	font-weight: var(--font-weight-semibold);
	text-transform: uppercase;
	letter-spacing: 0.06em;
	color: var(--color-text-tertiary);
	padding: 1px 6px;
	border-radius: 3px;
	background: var(--color-bg-surface);
}

.vq-item-type svg {
	flex-shrink: 0;
}

.vq-item-time {
	font-size: 0.625rem;
	color: var(--color-text-disabled);
	font-family: var(--font-mono);
	margin-left: auto;
}

.vq-item-subject {
	font-weight: var(--font-weight-semibold);
	font-size: 0.8125rem;
	color: var(--color-text-primary);
	line-height: 1.4;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.vq-item.is-auto .vq-item-subject {
	text-decoration: line-through;
	text-decoration-color: color-mix(in oklab, var(--color-success) 40%, transparent);
}

.vq-item-from {
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
}

/* ── Item actions ── */
.vq-item-actions {
	display: flex;
	align-items: center;
	gap: 4px;
	flex-shrink: 0;
}

.vq-action {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 30px;
	height: 30px;
	border-radius: 7px;
	border: 1px solid var(--color-border-subtle);
	background: var(--color-bg-surface);
	color: var(--color-text-tertiary);
	cursor: pointer;
	transition:
		border-color var(--motion-moderate),
		color var(--motion-moderate),
		background var(--motion-moderate),
		box-shadow var(--motion-moderate);
	font-family: inherit;
}

.vq-action:hover {
	background: var(--color-bg-surface-hover);
	border-color: var(--color-border-default);
}

.vq-action--approve {
	color: var(--color-success);
	border-color: color-mix(in oklab, var(--color-success) 20%, var(--color-border-subtle));
}

.vq-action--approve:hover {
	background: color-mix(in oklab, var(--color-success) 8%, var(--color-bg-surface));
	border-color: color-mix(in oklab, var(--color-success) 35%, var(--color-border-default));
	box-shadow: 0 0 8px rgba(122, 155, 110, 0.15);
}

.vq-action--edit:hover {
	color: var(--color-brand);
	border-color: color-mix(in oklab, var(--color-brand) 25%, var(--color-border-default));
}

.vq-action--reject:hover {
	color: var(--color-error);
	border-color: color-mix(in oklab, var(--color-error) 25%, var(--color-border-default));
}

/* Auto-approved badge */
.vq-auto-badge {
	display: flex;
	align-items: center;
	gap: 5px;
	padding: 4px 10px;
	border-radius: 6px;
	background: color-mix(in oklab, var(--color-success) 8%, var(--color-bg-surface));
	border: 1px solid color-mix(in oklab, var(--color-success) 20%, var(--color-border-subtle));
}

.vq-auto-badge svg {
	color: var(--color-success);
	flex-shrink: 0;
}

.vq-auto-badge span {
	font-size: 0.6875rem;
	font-weight: var(--font-weight-semibold);
	color: var(--color-success);
	white-space: nowrap;
}

/* ── Ambient ── */
.is-visible .vq-item--medium:not(.is-auto) {
	animation: item-attention 3s ease-in-out infinite 2s;
}

@keyframes item-attention {
	0%,
	100% {
		border-color: var(--color-border-default);
	}
	50% {
		border-color: color-mix(in oklab, var(--color-warning) 25%, var(--color-border-default));
	}
}

.is-visible .vq-item--low:not(.is-auto) {
	animation: item-attention-low 2.5s ease-in-out infinite 2.5s;
}

@keyframes item-attention-low {
	0%,
	100% {
		border-color: var(--color-border-default);
	}
	50% {
		border-color: color-mix(in oklab, var(--color-error) 20%, var(--color-border-default));
	}
}

@media (max-width: 520px) {
	.vq-item {
		flex-wrap: wrap;
		gap: 8px;
	}

	.vq-item-confidence {
		flex-direction: row;
		width: auto;
	}

	.vq-confidence-bar {
		width: 32px;
		height: 4px;
	}

	.vq-confidence-fill {
		bottom: 0;
		left: 0;
		top: 0;
		right: auto;
		width: var(--confidence);
		height: 100%;
	}

	.vq-item-actions {
		width: 100%;
		justify-content: flex-end;
	}
}
</style>
