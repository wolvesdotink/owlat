<script setup lang="ts">
/**
 * Converging connector of `::arch-communication-hub`: a drop under each of the
 * five channel cards, a merge bar, and a stem down to the pipeline card, with
 * a dot travelling each channel's path in turn.
 *
 * The column maths assumes the five-column channel grid above it. The
 * connector box itself (`.hub-connector`, its padding) is styled by the
 * parent; animations key off the parent's `.is-visible` root.
 */
</script>

<template>
	<div class="hub-connector hub-connector--converge">
		<div class="hub-converge">
			<!-- Vertical drops from each channel -->
			<div class="hub-converge-drop" v-for="i in 5" :key="i" :style="{ '--b': i - 1 }" />
			<!-- Horizontal merge bar -->
			<div class="hub-converge-bar" />
			<!-- Center stem down -->
			<div class="hub-converge-stem" />
			<!-- Animated dots cycling through channels -->
			<div class="hub-converge-dot hub-converge-dot--0" />
			<div class="hub-converge-dot hub-converge-dot--1" />
			<div class="hub-converge-dot hub-converge-dot--2" />
			<div class="hub-converge-dot hub-converge-dot--3" />
			<div class="hub-converge-dot hub-converge-dot--4" />
		</div>
	</div>
</template>

<style scoped>
.hub-converge {
	position: relative;
	width: 100%;
	display: grid;
	grid-template-columns: repeat(5, 1fr);
	gap: 8px;
	/* Column center positions accounting for gaps: center = col * (colWidth + gap) + colWidth/2 */
	--cg: 8px;
	--cw: calc((100% - 4 * var(--cg)) / 5);
	--c0: calc(var(--cw) / 2);
	--c1: calc(var(--cw) * 1.5 + var(--cg));
	--c2: calc(var(--cw) * 2.5 + 2 * var(--cg));
	--c3: calc(var(--cw) * 3.5 + 3 * var(--cg));
	--c4: calc(var(--cw) * 4.5 + 4 * var(--cg));
	/* Stem target: center of the pipeline card area (between c2 and c4) */
	--stem: calc((var(--c2) + var(--c4)) / 2);
}

/* Vertical drops — one under each channel card */
.hub-converge-drop {
	height: 16px;
	position: relative;
}

.hub-converge-drop::after {
	content: '';
	position: absolute;
	left: calc(50% - 1px);
	top: 0;
	width: 2px;
	height: calc(100% + 2px);
	background: var(--color-border-strong);
	transform-origin: top;
	border-radius: 1px;
}

.is-visible .hub-converge-drop::after {
	animation: line-draw 0.4s var(--ease-spring) both;
	animation-delay: calc(var(--b) * 0.05s + 0.15s);
}

/* Horizontal merge bar spanning full width */
.hub-converge-bar {
	position: absolute;
	top: 16px;
	left: calc(var(--c0) - 1px);
	right: calc(100% - var(--c4) - 1px);
	height: 2px;
	background: var(--color-border-strong);
	border-radius: 1px;
}

/* Center stem going down — aligned to pipeline card center */
.hub-converge-stem {
	position: absolute;
	top: 16px;
	left: var(--stem);
	width: 2px;
	height: 14px;
	background: var(--color-border-strong);
	transform: translateX(-50%);
	border-radius: 1px;
}

/* Animated dots — each starts from a different channel, travels down + across + down */
.hub-converge-dot {
	position: absolute;
	width: 5px;
	height: 5px;
	border-radius: 50%;
	background: var(--color-brand);
	opacity: 0;
	pointer-events: none;
	top: 0;
}

/* Dot 0: Email (1st column center) */
.hub-converge-dot--0 {
	left: calc(var(--c0) - 2.5px);
}

.is-visible .hub-converge-dot--0 {
	animation: dot-ch0 10s linear infinite 1.5s;
}

/* Dot 1: SMS (2nd column center) */
.hub-converge-dot--1 {
	left: calc(var(--c1) - 2.5px);
}

.is-visible .hub-converge-dot--1 {
	animation: dot-ch1 10s linear infinite 3.5s;
}

/* Dot 2: Chat (3rd column center) */
.hub-converge-dot--2 {
	left: calc(var(--c2) - 2.5px);
}

.is-visible .hub-converge-dot--2 {
	animation: dot-ch2 10s linear infinite 5.5s;
}

/* Dot 3: Webhooks (4th column center) */
.hub-converge-dot--3 {
	left: calc(var(--c3) - 2.5px);
}

.is-visible .hub-converge-dot--3 {
	animation: dot-ch3 10s linear infinite 7.5s;
}

/* Dot 4: Owlat (5th column center) */
.hub-converge-dot--4 {
	left: calc(var(--c4) - 2.5px);
}

.is-visible .hub-converge-dot--4 {
	animation: dot-ch4 10s linear infinite 9.5s;
}

/* Each dot: 3-phase L-path. Down to bar, across to stem, down the stem. */

/* Email (col 0 → stem): down, then RIGHT, then down */
@keyframes dot-ch0 {
	0% {
		top: 0;
		left: calc(var(--c0) - 2.5px);
		opacity: 0;
	}
	2% {
		top: 0;
		left: calc(var(--c0) - 2.5px);
		opacity: 1;
	}
	8% {
		top: 14px;
		left: calc(var(--c0) - 2.5px);
		opacity: 1;
	}
	8.01% {
		top: 14px;
		left: calc(var(--c0) - 2.5px);
		opacity: 1;
	}
	16% {
		top: 14px;
		left: calc(var(--stem) - 2.5px);
		opacity: 1;
	}
	16.01% {
		top: 14px;
		left: calc(var(--stem) - 2.5px);
		opacity: 1;
	}
	24% {
		top: 30px;
		left: calc(var(--stem) - 2.5px);
		opacity: 1;
	}
	26% {
		top: 30px;
		left: calc(var(--stem) - 2.5px);
		opacity: 0;
	}
	100% {
		top: 30px;
		left: calc(var(--stem) - 2.5px);
		opacity: 0;
	}
}

/* SMS (col 1 → stem): down, then RIGHT, then down */
@keyframes dot-ch1 {
	0% {
		top: 0;
		left: calc(var(--c1) - 2.5px);
		opacity: 0;
	}
	2% {
		top: 0;
		left: calc(var(--c1) - 2.5px);
		opacity: 1;
	}
	8% {
		top: 14px;
		left: calc(var(--c1) - 2.5px);
		opacity: 1;
	}
	8.01% {
		top: 14px;
		left: calc(var(--c1) - 2.5px);
		opacity: 1;
	}
	16% {
		top: 14px;
		left: calc(var(--stem) - 2.5px);
		opacity: 1;
	}
	16.01% {
		top: 14px;
		left: calc(var(--stem) - 2.5px);
		opacity: 1;
	}
	24% {
		top: 30px;
		left: calc(var(--stem) - 2.5px);
		opacity: 1;
	}
	26% {
		top: 30px;
		left: calc(var(--stem) - 2.5px);
		opacity: 0;
	}
	100% {
		top: 30px;
		left: calc(var(--stem) - 2.5px);
		opacity: 0;
	}
}

/* Chat (col 2 → stem): down, then RIGHT, then down */
@keyframes dot-ch2 {
	0% {
		top: 0;
		left: calc(var(--c2) - 2.5px);
		opacity: 0;
	}
	2% {
		top: 0;
		left: calc(var(--c2) - 2.5px);
		opacity: 1;
	}
	8% {
		top: 14px;
		left: calc(var(--c2) - 2.5px);
		opacity: 1;
	}
	8.01% {
		top: 14px;
		left: calc(var(--c2) - 2.5px);
		opacity: 1;
	}
	16% {
		top: 14px;
		left: calc(var(--stem) - 2.5px);
		opacity: 1;
	}
	16.01% {
		top: 14px;
		left: calc(var(--stem) - 2.5px);
		opacity: 1;
	}
	24% {
		top: 30px;
		left: calc(var(--stem) - 2.5px);
		opacity: 1;
	}
	26% {
		top: 30px;
		left: calc(var(--stem) - 2.5px);
		opacity: 0;
	}
	100% {
		top: 30px;
		left: calc(var(--stem) - 2.5px);
		opacity: 0;
	}
}

/* Webhooks (col 3 → stem): down, then LEFT, then down */
@keyframes dot-ch3 {
	0% {
		top: 0;
		left: calc(var(--c3) - 2.5px);
		opacity: 0;
	}
	2% {
		top: 0;
		left: calc(var(--c3) - 2.5px);
		opacity: 1;
	}
	8% {
		top: 14px;
		left: calc(var(--c3) - 2.5px);
		opacity: 1;
	}
	8.01% {
		top: 14px;
		left: calc(var(--c3) - 2.5px);
		opacity: 1;
	}
	16% {
		top: 14px;
		left: calc(var(--stem) - 2.5px);
		opacity: 1;
	}
	16.01% {
		top: 14px;
		left: calc(var(--stem) - 2.5px);
		opacity: 1;
	}
	24% {
		top: 30px;
		left: calc(var(--stem) - 2.5px);
		opacity: 1;
	}
	26% {
		top: 30px;
		left: calc(var(--stem) - 2.5px);
		opacity: 0;
	}
	100% {
		top: 30px;
		left: calc(var(--stem) - 2.5px);
		opacity: 0;
	}
}

/* Owlat (col 4 → stem): down, then LEFT, then down */
@keyframes dot-ch4 {
	0% {
		top: 0;
		left: calc(var(--c4) - 2.5px);
		opacity: 0;
	}
	2% {
		top: 0;
		left: calc(var(--c4) - 2.5px);
		opacity: 1;
	}
	8% {
		top: 14px;
		left: calc(var(--c4) - 2.5px);
		opacity: 1;
	}
	8.01% {
		top: 14px;
		left: calc(var(--c4) - 2.5px);
		opacity: 1;
	}
	16% {
		top: 14px;
		left: calc(var(--stem) - 2.5px);
		opacity: 1;
	}
	16.01% {
		top: 14px;
		left: calc(var(--stem) - 2.5px);
		opacity: 1;
	}
	24% {
		top: 30px;
		left: calc(var(--stem) - 2.5px);
		opacity: 1;
	}
	26% {
		top: 30px;
		left: calc(var(--stem) - 2.5px);
		opacity: 0;
	}
	100% {
		top: 30px;
		left: calc(var(--stem) - 2.5px);
		opacity: 0;
	}
}

/* Scoped keyframes are renamed per component, so the drops need their own copy. */
@keyframes line-draw {
	from {
		transform: scaleY(0);
	}
	to {
		transform: scaleY(1);
	}
}
</style>
