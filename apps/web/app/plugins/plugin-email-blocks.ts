import { armEmailBlockRegistryFreeze } from '@owlat/email-renderer/registry-latch';

/**
 * Host boot: latch the email-block registries shut on first use.
 *
 * The renderer and editor block registries are populated by built-in
 * side-effect registration when `@owlat/email-renderer` / `@owlat/email-builder`
 * are imported. Both packages are loaded lazily (the builder, the renderer,
 * SortableJS and sanitize-html are not part of the boot bundle), so the host
 * cannot compose and freeze them here. It arms the freeze-on-first-read latch
 * instead: the first read of any block registry freezes every block registry,
 * which is exactly what `composeHostedEmailBlocks([])` did at boot, because no
 * bundled plugin contributes email blocks. A registry is therefore never read
 * while still open to mutation.
 *
 * The latch lives in a leaf module and arming is idempotent, so a dev HMR
 * re-eval or a repeated SSR import cannot compose or freeze twice.
 */
armEmailBlockRegistryFreeze();

export default defineNuxtPlugin({
	name: 'owlat:email-block-registries',
	setup() {},
});
