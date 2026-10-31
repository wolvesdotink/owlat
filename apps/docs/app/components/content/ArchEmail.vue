<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { docsSendProviders } from '../../utils/sendProviderDiagrams';
import ArchEmailBuilderItems from '../diagrams/ArchEmailBuilderItems.vue';
import ArchEmailConnector from '../diagrams/ArchEmailConnector.vue';
import ArchEmailPipelineFeatures from '../diagrams/ArchEmailPipelineFeatures.vue';
import ArchEmailSesManager from '../diagrams/ArchEmailSesManager.vue';
import { ownDetail } from '../../utils/diagrams/archEmail';

const visible = ref(false);
onMounted(() => {
	requestAnimationFrame(() => {
		visible.value = true;
	});
});

const providers = docsSendProviders();
</script>

<template>
	<div class="arch-email" :class="{ 'is-visible': visible }">
		<!-- Email Builder -->
		<div class="email-section email-section--builder" :style="{ '--s': 0 }">
			<div class="email-section-header">
				<div class="email-section-icon">
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path
							d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
						/>
					</svg>
				</div>
				<span class="email-section-label">Email Builder</span>
			</div>
			<ArchEmailBuilderItems />
		</div>

		<!-- Connector: Builder → Rendering -->
		<ArchEmailConnector :s="1" />

		<!-- Email Rendering -->
		<div class="email-section email-section--rendering" :style="{ '--s': 2 }">
			<div class="email-section-header">
				<div class="email-section-icon email-section-icon--accent">
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
					</svg>
				</div>
				<span class="email-section-label">Email Rendering</span>
			</div>
			<div class="email-pipeline">
				<span class="email-pipeline-step">JSON Blocks</span>
				<svg class="email-pipeline-arrow" width="20" height="12" viewBox="0 0 20 12" fill="none">
					<path
						d="M1 6h16m0 0l-4-4m4 4l-4 4"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
				<span class="email-pipeline-step email-pipeline-step--brand">@owlat/email-renderer</span>
				<svg class="email-pipeline-arrow" width="20" height="12" viewBox="0 0 20 12" fill="none">
					<path
						d="M1 6h16m0 0l-4-4m4 4l-4 4"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
				<span class="email-pipeline-step email-pipeline-step--success">HTML Email</span>
			</div>
			<div class="email-tags">
				<span class="email-tag">Responsive layouts</span>
				<span class="email-tag">Cross-client compatibility</span>
			</div>
		</div>

		<!-- Connector: Rendering → Providers -->
		<ArchEmailConnector :s="3" />

		<!-- Email Providers -->
		<div class="email-section email-section--providers" :style="{ '--s': 4 }">
			<div class="email-section-header">
				<div class="email-section-icon email-section-icon--info">
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
					</svg>
				</div>
				<span class="email-section-label">Email Delivery</span>
			</div>

			<!-- Default provider (MTA) -->
			<div class="email-provider email-provider--default" :style="{ '--i': 6 }">
				<div class="email-provider-icon email-provider-icon--brand">
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path :d="providers.own.icon" />
					</svg>
				</div>
				<div class="email-provider-text">
					<span class="email-provider-name">{{ providers.own.name }}</span>
					<span class="email-provider-detail">{{ ownDetail }}</span>
				</div>
				<span class="email-provider-badge">Default</span>
			</div>

			<!-- Alternative providers -->
			<div class="email-alt-label" :style="{ '--i': 7 }">Optional alternatives</div>
			<div class="email-providers">
				<div
					v-for="(prov, i) in providers.alternatives"
					:key="prov.kind"
					class="email-provider"
					:style="{ '--i': i + 8 }"
				>
					<div class="email-provider-icon">
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path :d="prov.icon" />
						</svg>
					</div>
					<div class="email-provider-text">
						<span class="email-provider-name">{{ prov.name }}</span>
						<span class="email-provider-detail">Optional</span>
					</div>
				</div>
			</div>

			<!-- SES Identity Manager -->
			<ArchEmailSesManager :stagger="providers.alternatives.length + 8" />

			<!-- Pipeline features -->
			<ArchEmailPipelineFeatures :stagger-offset="providers.alternatives.length + 8" />
		</div>
	</div>
</template>

<style scoped>
.arch-email {
	margin: 2rem 0;
	display: flex;
	flex-direction: column;
	align-items: stretch;
}

/* ── Sections ── */
.email-section {
	border: 1px solid var(--color-border-default);
	border-radius: 12px;
	padding: 16px 18px;
	background: var(--color-bg-elevated);
	opacity: 0;
	transform: translateY(14px);
	transition:
		opacity 0.6s var(--ease-spring),
		transform 0.6s var(--ease-spring),
		border-color var(--motion-moderate),
		box-shadow var(--motion-moderate);
	transition-delay: calc(var(--s) * 0.12s);
	position: relative;
	overflow: hidden;
}

.is-visible .email-section {
	opacity: 1;
	transform: translateY(0);
}

.email-section:hover {
	border-color: var(--color-border-strong);
	box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}

.email-section-header {
	display: flex;
	align-items: center;
	gap: 10px;
	margin-bottom: 14px;
}

.email-section-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 30px;
	height: 30px;
	border-radius: 8px;
	background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
	color: var(--color-brand);
}

.email-section-icon--accent {
	background: color-mix(in oklab, var(--color-accent) 12%, var(--color-bg-surface));
	color: var(--color-accent);
}

.email-section-icon--info {
	background: color-mix(in oklab, var(--color-info) 12%, var(--color-bg-surface));
	color: var(--color-info);
}

.email-section-label {
	font-weight: var(--font-weight-semibold);
	font-size: 0.9375rem;
	color: var(--color-text-primary);
}

/* ── Rendering pipeline ── */
.email-pipeline {
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: wrap;
	margin-bottom: 12px;
}

.email-pipeline-step {
	padding: 6px 12px;
	border-radius: 6px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	font-size: 0.75rem;
	font-family: var(--font-mono);
	color: var(--color-text-secondary);
	white-space: nowrap;
	transition:
		border-color var(--motion-moderate),
		color var(--motion-moderate);
}

.email-pipeline-step--brand {
	border-color: var(--color-brand-dim);
	color: var(--color-brand);
	background: color-mix(in oklab, var(--color-brand) 6%, var(--color-bg-surface));
}

.email-pipeline-step--success {
	border-color: color-mix(in oklab, var(--color-success) 30%, var(--color-border-subtle));
	color: var(--color-success);
	background: color-mix(in oklab, var(--color-success) 6%, var(--color-bg-surface));
}

.email-pipeline-arrow {
	color: var(--color-text-disabled);
	flex-shrink: 0;
	transition: color var(--motion-moderate);
}

.email-section--rendering:hover .email-pipeline-arrow {
	color: var(--color-brand-dim);
}

.email-tags {
	display: flex;
	gap: 6px;
	flex-wrap: wrap;
}

.email-tag {
	padding: 3px 10px;
	border-radius: 9999px;
	background: var(--color-bg-soft);
	border: 1px solid var(--color-border-subtle);
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
}

/* ── Default provider card ── */
.email-provider--default {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 12px 16px;
	border-radius: 8px;
	background: color-mix(in oklab, var(--color-brand) 6%, var(--color-bg-surface));
	border: 1px solid var(--color-brand-dim);
	margin-bottom: 12px;
	opacity: 0;
	transform: translateY(8px);
	transition:
		border-color var(--motion-moderate),
		transform var(--motion-moderate) var(--ease-spring),
		background var(--motion-moderate),
		opacity var(--motion-slow) var(--ease-spring);
}

.is-visible .email-provider--default {
	opacity: 1;
	transform: translateY(0);
	transition-delay: calc(0.15s + var(--i) * 0.07s);
}

.email-provider--default:hover {
	border-color: var(--color-brand);
	transform: translateY(-1px);
	transition-delay: 0s;
}

.email-provider-icon--brand {
	background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
	color: var(--color-brand);
}

.email-provider-badge {
	margin-left: auto;
	padding: 2px 8px;
	border-radius: 9999px;
	background: color-mix(in oklab, var(--color-brand) 15%, var(--color-bg-surface));
	color: var(--color-brand);
	font-size: 0.6875rem;
	font-weight: var(--font-weight-semibold);
	flex-shrink: 0;
}

.email-alt-label {
	font-size: 0.6875rem;
	font-weight: var(--font-weight-medium);
	color: var(--color-text-tertiary);
	text-transform: uppercase;
	letter-spacing: 0.05em;
	margin-bottom: 6px;
	opacity: 0;
	transition: opacity var(--motion-slow) var(--ease-spring);
}

.is-visible .email-alt-label {
	opacity: 1;
	transition-delay: calc(0.15s + var(--i) * 0.07s);
}

/* ── Providers ── */
.email-providers {
	display: grid;
	grid-template-columns: repeat(2, 1fr);
	gap: 10px;
	margin-bottom: 12px;
}

@media (max-width: 580px) {
	.email-providers {
		grid-template-columns: 1fr;
	}
}

.email-provider {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 10px 14px;
	border-radius: 8px;
	background: var(--color-bg-surface);
	border: 1px solid transparent;
	transition:
		border-color var(--motion-moderate),
		transform var(--motion-moderate) var(--ease-spring),
		background var(--motion-moderate);
	opacity: 0;
	transform: translateY(8px);
}

.is-visible .email-provider {
	opacity: 1;
	transform: translateY(0);
	transition-delay: calc(0.15s + var(--i) * 0.07s);
}

.email-provider:hover {
	border-color: var(--color-border-default);
	background: var(--color-bg-surface-hover);
	transform: translateY(-1px);
	transition-delay: 0s;
}

.email-provider-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	border-radius: 8px;
	background: var(--color-bg-elevated);
	color: var(--color-info);
	flex-shrink: 0;
}

.email-provider-text {
	display: flex;
	flex-direction: column;
	gap: 1px;
}

.email-provider-name {
	font-weight: var(--font-weight-semibold);
	font-size: 0.8125rem;
	color: var(--color-text-primary);
}

.email-provider-detail {
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
}

.is-visible .email-pipeline-arrow:nth-child(4) {
	animation-delay: 0.5s;
}
</style>
