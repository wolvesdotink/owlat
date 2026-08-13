<template>
	<!-- Decorative hero field (marketing landing idiom): hairline grid + grain +
	     warm aurora. Purely ornamental — sits behind the content inside a
	     `relative isolate overflow-hidden` container, ignores the pointer, and
	     is hidden from assistive tech. -->
	<div class="absolute inset-0 hero-grid" aria-hidden="true" />
	<div class="absolute inset-0 hero-grain" aria-hidden="true" />
	<div class="absolute inset-0 overflow-hidden" aria-hidden="true">
		<div class="lp-aurora lp-aurora-gold" />
		<div class="lp-aurora lp-aurora-core" />
	</div>
</template>
