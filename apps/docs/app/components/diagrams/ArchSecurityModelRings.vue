<script setup lang="ts">
/**
 * The nested-rings figure of `ArchSecurityModel`: tenant, sandbox and audit
 * boundaries around the agent.
 *
 * The entrance and pulse rules key off the parent's `.is-visible`; scoped CSS only
 * scopes the last selector part, so that ancestor class still matches.
 */
</script>

<template>
	<div class="sec-rings" :style="{ '--stagger': 0 }">
		<div class="sec-rings-visual">
			<!-- Outermost ring: Tenant isolation -->
			<div class="sec-ring sec-ring--tenant">
				<span class="sec-ring-label sec-ring-label--top">Tenant Isolation</span>
				<!-- Second ring: Sandboxing -->
				<div class="sec-ring sec-ring--sandbox">
					<span class="sec-ring-label sec-ring-label--top">Agent Sandbox</span>
					<!-- Third ring: Audit -->
					<div class="sec-ring sec-ring--audit">
						<span class="sec-ring-label sec-ring-label--top">Audit Trail</span>
						<!-- Core: Agent -->
						<div class="sec-core">
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
								<path d="M13 10V3L4 14h7v7l9-11h-7z" />
							</svg>
							<span>Agent</span>
						</div>
					</div>
				</div>
			</div>
		</div>

		<div class="sec-rings-desc">
			Every agent operates within nested security boundaries. No layer can be bypassed.
		</div>
	</div>
</template>

<style scoped>
/* ── Nested rings visualization ── */
.sec-rings {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 14px;
	padding: 24px 16px;
	border: 1px solid var(--color-border-default);
	border-radius: 12px;
	background: var(--color-bg-elevated);
	position: relative;
	overflow: hidden;
	opacity: 0;
	transform: translateY(12px);
	transition:
		opacity 0.6s var(--ease-spring),
		transform 0.6s var(--ease-spring),
		border-color var(--motion-moderate);
	transition-delay: calc(var(--stagger) * 0.12s);
}

.sec-rings::before {
	content: '';
	position: absolute;
	inset: 0;
	background: radial-gradient(ellipse at 50% 50%, rgba(196, 120, 90, 0.03) 0%, transparent 70%);
	pointer-events: none;
}

.is-visible .sec-rings {
	opacity: 1;
	transform: translateY(0);
}

.sec-rings:hover {
	border-color: var(--color-border-strong);
}

.sec-rings-visual {
	position: relative;
}

/* Concentric rings */
.sec-ring {
	display: flex;
	align-items: center;
	justify-content: center;
	border-radius: 50%;
	position: relative;
}

.sec-ring--tenant {
	width: 260px;
	height: 260px;
	border: 1.5px solid color-mix(in oklab, var(--color-brand) 30%, var(--color-border-default));
	background: color-mix(in oklab, var(--color-brand) 2%, var(--color-bg-elevated));
}

.sec-ring--sandbox {
	width: 180px;
	height: 180px;
	border: 1.5px solid color-mix(in oklab, var(--color-accent) 30%, var(--color-border-default));
	background: color-mix(in oklab, var(--color-accent) 2%, var(--color-bg-elevated));
}

.sec-ring--audit {
	width: 110px;
	height: 110px;
	border: 1.5px solid color-mix(in oklab, var(--color-info) 30%, var(--color-border-default));
	background: color-mix(in oklab, var(--color-info) 2%, var(--color-bg-elevated));
}

.sec-ring-label {
	position: absolute;
	font-size: 0.5625rem;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	white-space: nowrap;
	padding: 1px 6px;
	border-radius: 3px;
	background: var(--color-bg-elevated);
}

.sec-ring-label--top {
	top: -1px;
	left: 50%;
	transform: translate(-50%, -50%);
}

.sec-ring--tenant > .sec-ring-label {
	color: var(--color-brand);
}
.sec-ring--sandbox > .sec-ring-label {
	color: var(--color-accent);
}
.sec-ring--audit > .sec-ring-label {
	color: var(--color-info);
}

/* Ambient ring pulse */
.is-visible .sec-ring--tenant {
	animation: ring-pulse-brand 4s ease-in-out infinite 1s;
}

.is-visible .sec-ring--sandbox {
	animation: ring-pulse-accent 4s ease-in-out infinite 1.5s;
}

.is-visible .sec-ring--audit {
	animation: ring-pulse-info 4s ease-in-out infinite 2s;
}

@keyframes ring-pulse-brand {
	0%,
	100% {
		border-color: color-mix(in oklab, var(--color-brand) 30%, var(--color-border-default));
	}
	50% {
		border-color: color-mix(in oklab, var(--color-brand) 50%, var(--color-border-default));
	}
}

@keyframes ring-pulse-accent {
	0%,
	100% {
		border-color: color-mix(in oklab, var(--color-accent) 30%, var(--color-border-default));
	}
	50% {
		border-color: color-mix(in oklab, var(--color-accent) 50%, var(--color-border-default));
	}
}

@keyframes ring-pulse-info {
	0%,
	100% {
		border-color: color-mix(in oklab, var(--color-info) 30%, var(--color-border-default));
	}
	50% {
		border-color: color-mix(in oklab, var(--color-info) 50%, var(--color-border-default));
	}
}

/* Core agent */
.sec-core {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 3px;
	color: var(--color-success);
}

.sec-core svg {
	opacity: 0;
	transform: scale(0.6);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
}

.is-visible .sec-core svg {
	opacity: 1;
	transform: scale(1);
	transition-delay: 0.5s;
}

.sec-core span {
	font-size: 0.625rem;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.06em;
}

.sec-rings-desc {
	font-size: 0.75rem;
	color: var(--color-text-tertiary);
	text-align: center;
	position: relative;
}

@media (max-width: 400px) {
	.sec-ring--tenant {
		width: 200px;
		height: 200px;
	}
	.sec-ring--sandbox {
		width: 140px;
		height: 140px;
	}
	.sec-ring--audit {
		width: 86px;
		height: 86px;
	}
}
</style>
