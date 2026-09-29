<script setup lang="ts">
/**
 * A sent email shown to someone outside the workspace (the share preview and
 * the campaign archive): the subject as the page heading, the email itself in
 * a sandboxed frame sized to its content, and the small Owlat credit.
 *
 * The sandbox policy for these public pages is decided here and nowhere else.
 * The `#meta` slot is the line under the subject (sender, date, expiry).
 */
import RecipientFooter from './RecipientFooter.vue';

defineProps<{ subject: string; html: string; frameTitle: string }>();

/** Fallback height before the email's own height is known. */
const MIN_HEIGHT = 600;

function fitToContent(event: Event): void {
	const frame = event.target as HTMLIFrameElement;
	const height = frame.contentDocument?.documentElement?.scrollHeight ?? MIN_HEIGHT;
	frame.style.height = `${height}px`;
}
</script>

<template>
	<div>
		<header class="border-b border-border-subtle bg-bg-elevated pt-[env(safe-area-inset-top)]">
			<div class="mx-auto max-w-3xl px-5 py-4">
				<h1 class="text-lg font-medium tracking-[-0.02em] break-words text-text-primary">
					{{ subject }}
				</h1>
				<slot name="meta" />
			</div>
		</header>

		<div class="mx-auto my-5 max-w-3xl px-5 sm:my-8">
			<div class="overflow-hidden rounded-(--radius-card) shadow-surface-2">
				<!--
					The email was authored for a light canvas, so the paper stays
					light in BOTH color schemes: `light` re-resolves the token layer
					for this subtree (see packages/ui/assets/css/light.css) and
					`scheme-only-light` keeps the framed document from picking up the
					recipient's dark preference. Inverting it would leave dark-on-dark
					email text unreadable.
				-->
				<div class="light bg-surface-3">
					<!--
						`allow-same-origin` is required so the @load handler can read
						contentDocument to size the frame to the email. NEVER add
						`allow-scripts`: same-origin + scripts lets the framed HTML
						escape the sandbox entirely. This frame renders untrusted
						email HTML, so it must stay script-free.
					-->
					<iframe
						:srcdoc="html"
						sandbox="allow-same-origin"
						:title="frameTitle"
						class="w-full border-0 scheme-only-light"
						:style="{ minHeight: `${MIN_HEIGHT}px` }"
						@load="fitToContent"
					/>
				</div>
			</div>
		</div>

		<RecipientFooter class="pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-center" />
	</div>
</template>
