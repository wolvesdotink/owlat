<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { docsSendProviders } from '../../utils/sendProviderDiagrams';
import EmailArchitectureConnector from '../diagrams/EmailArchitectureConnector.vue';
import EmailArchitectureFeatures from '../diagrams/EmailArchitectureFeatures.vue';
import EmailArchitecturePipelineFeatures from '../diagrams/EmailArchitecturePipelineFeatures.vue';
import { blockTypes, ownDetail, renderFeatures } from '../../utils/diagrams/emailArchitecture';

const visible = ref(false);
onMounted(() => {
	requestAnimationFrame(() => {
		visible.value = true;
	});
});

const providers = docsSendProviders();
</script>

<template>
	<div class="email-arch" :class="{ 'is-visible': visible }">
		<!-- Email Builder -->
		<div class="ea-section" :style="{ '--s': 0 }">
			<div class="ea-header">
				<div class="ea-icon">
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
				<span class="ea-label">Email Builder</span>
			</div>

			<!-- Inline Editor features -->
			<div class="ea-sublabel">Inline Editor</div>
			<EmailArchitectureFeatures />

			<!-- Block system -->
			<div class="ea-sublabel" style="margin-top: 14px">Block System</div>
			<div class="ea-blocks">
				<span
					v-for="(block, i) in blockTypes"
					:key="block"
					class="ea-block"
					:style="{ '--i': i + 5 }"
					>{{ block }}</span
				>
				<span class="ea-block ea-block--more" :style="{ '--i': 13 }">+10 more</span>
			</div>
		</div>

		<!-- Connector: Builder → Rendering -->
		<EmailArchitectureConnector :s="1" label="JSON" />

		<!-- Email Rendering -->
		<div class="ea-section ea-section--rendering" :style="{ '--s': 2 }">
			<div class="ea-header">
				<div class="ea-icon ea-icon--accent">
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
				<span class="ea-label">Email Rendering</span>
			</div>
			<div class="ea-pipeline">
				<span class="ea-step">JSON Blocks</span>
				<svg class="ea-arrow" width="20" height="12" viewBox="0 0 20 12" fill="none">
					<path
						d="M1 6h16m0 0l-4-4m4 4l-4 4"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
				<span class="ea-step ea-step--brand">@owlat/email-renderer</span>
				<svg class="ea-arrow" width="20" height="12" viewBox="0 0 20 12" fill="none">
					<path
						d="M1 6h16m0 0l-4-4m4 4l-4 4"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
				<span class="ea-step ea-step--success">HTML Email</span>
			</div>
			<div class="ea-tags">
				<span v-for="feat in renderFeatures" :key="feat" class="ea-tag">{{ feat }}</span>
			</div>
		</div>

		<!-- Connector: Rendering → Providers -->
		<EmailArchitectureConnector :s="3" label="HTML" />

		<!-- Email Providers -->
		<div class="ea-section ea-section--providers" :style="{ '--s': 4 }">
			<div class="ea-header">
				<div class="ea-icon ea-icon--info">
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
				<span class="ea-label">Email Delivery</span>
			</div>

			<!-- Default provider (MTA) -->
			<div class="ea-provider ea-provider--default" :style="{ '--i': 9 }">
				<div class="ea-provider-icon ea-provider-icon--brand">
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
				<div class="ea-provider-text">
					<span class="ea-provider-name">{{ providers.own.name }}</span>
					<span class="ea-provider-detail">{{ ownDetail }}</span>
				</div>
				<span class="ea-provider-badge">Default</span>
			</div>

			<!-- Alternative providers -->
			<div class="ea-sublabel" style="margin-top: 4px">Optional alternatives</div>
			<div class="ea-providers">
				<div
					v-for="(prov, i) in providers.alternatives"
					:key="prov.kind"
					class="ea-provider"
					:style="{ '--i': i + 10 }"
				>
					<div class="ea-provider-icon">
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
					<div class="ea-provider-text">
						<span class="ea-provider-name">{{ prov.name }}</span>
						<span class="ea-provider-detail">Optional</span>
					</div>
				</div>
			</div>

			<EmailArchitecturePipelineFeatures :stagger-offset="providers.alternatives.length + 9" />
		</div>
	</div>
</template>

<style scoped>
.email-arch {
	margin: 2rem 0;
	display: flex;
	flex-direction: column;
	align-items: stretch;
}

/* Sections */
.ea-section {
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

.is-visible .ea-section {
	opacity: 1;
	transform: translateY(0);
}

.ea-section:hover {
	border-color: var(--color-border-strong);
	box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}

.ea-header {
	display: flex;
	align-items: center;
	gap: 10px;
	margin-bottom: 14px;
}

.ea-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 30px;
	height: 30px;
	border-radius: 8px;
	background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
	color: var(--color-brand);
}

.ea-icon--accent {
	background: color-mix(in oklab, var(--color-accent) 12%, var(--color-bg-surface));
	color: var(--color-accent);
}

.ea-icon--info {
	background: color-mix(in oklab, var(--color-info) 12%, var(--color-bg-surface));
	color: var(--color-info);
}

.ea-label {
	font-weight: var(--font-weight-semibold);
	font-size: 0.9375rem;
	color: var(--color-text-primary);
}

.ea-sublabel {
	font-size: 0.6875rem;
	font-weight: var(--font-weight-semibold);
	text-transform: uppercase;
	letter-spacing: 0.05em;
	color: var(--color-text-tertiary);
	margin-bottom: 8px;
}

/* Block types */
.ea-blocks {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}

.ea-block {
	padding: 4px 10px;
	border-radius: 6px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	font-size: 0.6875rem;
	font-family: var(--font-mono);
	color: var(--color-text-secondary);
	transition:
		border-color var(--motion-moderate),
		color var(--motion-moderate);
	opacity: 0;
}

.is-visible .ea-block {
	opacity: 1;
	transition-delay: calc(0.1s + var(--i) * 0.04s);
}

.ea-block:hover {
	border-color: var(--color-border-default);
	color: var(--color-text-primary);
}

.ea-block--more {
	border-style: dashed;
	color: var(--color-text-tertiary);
}

/* Pipeline */
.ea-pipeline {
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: wrap;
	margin-bottom: 12px;
}

.ea-step {
	padding: 6px 12px;
	border-radius: 6px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	font-size: 0.75rem;
	font-family: var(--font-mono);
	color: var(--color-text-secondary);
	white-space: nowrap;
}

.ea-step--brand {
	border-color: var(--color-brand-dim);
	color: var(--color-brand);
	background: color-mix(in oklab, var(--color-brand) 6%, var(--color-bg-surface));
}

.ea-step--success {
	border-color: color-mix(in oklab, var(--color-success) 30%, var(--color-border-subtle));
	color: var(--color-success);
	background: color-mix(in oklab, var(--color-success) 6%, var(--color-bg-surface));
}

.ea-arrow {
	color: var(--color-text-disabled);
	flex-shrink: 0;
}

.is-visible .ea-arrow:nth-of-type(2) {
	animation-delay: 0.5s;
}

.ea-tags {
	display: flex;
	gap: 6px;
	flex-wrap: wrap;
}

.ea-tag {
	padding: 3px 10px;
	border-radius: 9999px;
	background: var(--color-bg-soft);
	border: 1px solid var(--color-border-subtle);
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
}

/* Default provider card */
.ea-provider--default {
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

.is-visible .ea-provider--default {
	opacity: 1;
	transform: translateY(0);
	transition-delay: calc(0.15s + var(--i) * 0.07s);
}

.ea-provider--default:hover {
	border-color: var(--color-brand);
	transform: translateY(-1px);
	transition-delay: 0s;
}

.ea-provider-icon--brand {
	background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
	color: var(--color-brand);
}

.ea-provider-badge {
	margin-left: auto;
	padding: 2px 8px;
	border-radius: 9999px;
	background: color-mix(in oklab, var(--color-brand) 15%, var(--color-bg-surface));
	color: var(--color-brand);
	font-size: 0.6875rem;
	font-weight: var(--font-weight-semibold);
	flex-shrink: 0;
}

/* Providers */
.ea-providers {
	display: grid;
	grid-template-columns: repeat(2, 1fr);
	gap: 10px;
	margin-bottom: 12px;
}

@media (max-width: 580px) {
	.ea-providers {
		grid-template-columns: 1fr;
	}
}

.ea-provider {
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

.is-visible .ea-provider {
	opacity: 1;
	transform: translateY(0);
	transition-delay: calc(0.15s + var(--i) * 0.07s);
}

.ea-provider:hover {
	border-color: var(--color-border-default);
	background: var(--color-bg-surface-hover);
	transform: translateY(-1px);
	transition-delay: 0s;
}

.ea-provider-icon {
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

.ea-provider-text {
	display: flex;
	flex-direction: column;
	gap: 1px;
}

.ea-provider-name {
	font-weight: var(--font-weight-semibold);
	font-size: 0.8125rem;
	color: var(--color-text-primary);
}

.ea-provider-detail {
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
}
</style>
