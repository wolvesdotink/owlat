<template>
	<div class="min-h-dvh flex flex-col">
		<SiteHeader />
		<main class="flex-1">
			<slot />
		</main>
		<SiteFooter />
	</div>
</template>
