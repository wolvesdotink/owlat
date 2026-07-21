import { areEmailBlockRegistriesFrozen, composeHostedEmailBlocks } from '@owlat/email-builder';

/**
 * Host boot: freeze the email-block registries.
 *
 * The renderer and editor block registries are populated by built-in
 * side-effect registration at package import. This plugin runs the host's
 * email-block composition once at boot: with no bundled plugin contributing
 * blocks yet the contribution list is empty, and the call latches every block
 * registry shut — closing the silent-mutation window that existed while the
 * freeze functions were never called.
 *
 * The composition runs at module evaluation (once per process, after the built-
 * ins have registered via the `@owlat/email-builder` import), guarded so a dev
 * HMR re-eval or a repeated SSR import does not compose a second time against
 * already-frozen registries.
 */
export const composedEmailBlocks = areEmailBlockRegistriesFrozen()
	? []
	: composeHostedEmailBlocks([]);

export default defineNuxtPlugin({
	name: 'owlat:email-block-registries',
	setup() {
		void composedEmailBlocks;
	},
});
