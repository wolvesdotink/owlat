import rule from '../noRawKeydownListener.ts';
import { ruleTester } from '../../__tests__/ruleTester.ts';

const filename = 'apps/web/app/composables/useThing.ts';

ruleTester.run('owlat/no-raw-keydown-listener', rule, {
	valid: [
		{
			name: 'another event on the window',
			filename,
			code: "window.addEventListener('keyup', onKeyup);",
		},
		{
			name: 'a listener added for a list of event names',
			filename,
			code: "for (const name of ['wheel', 'keydown']) window.addEventListener(name, onUse);",
		},
		{
			name: 'removing a listener',
			filename,
			code: "window.removeEventListener('keydown', onKeydown);",
		},
		{
			name: 'a binding through the registry',
			filename,
			code: "useKeyboardShortcuts().registerShortcut({ id: 'global.settings', handler: open });",
		},
		{
			name: 'a test file drives keys itself',
			filename: 'apps/web/app/composables/__tests__/useThing.test.ts',
			code: "document.addEventListener('keydown', spy);",
		},
		{
			name: 'a file named like a test',
			filename: 'apps/web/app/utils/thing.spec.ts',
			code: "window.addEventListener('keydown', spy);",
		},
		{
			name: 'a file outside the configured paths',
			filename: 'packages/ui/composables/useEscapeLayer.ts',
			options: [{ files: ['apps/web/app/**'] }],
			code: "window.addEventListener('keydown', onKeydown, true);",
		},
		{
			name: 'a computed property is not read',
			filename,
			code: "const key = 'onkeydown'; (element as any)[key] = handler;",
		},
	],
	invalid: [
		{
			name: 'a window listener',
			filename,
			code: "window.addEventListener('keydown', onKeydown);",
			errors: 1,
		},
		{
			name: 'a file inside the configured paths, from any working directory',
			filename: '/checkout/apps/web/app/composables/useThing.ts',
			options: [{ files: ['apps/web/app/**'] }],
			code: "window.addEventListener('keydown', onKeydown);",
			errors: 1,
		},
		{
			name: 'a document listener in the capture phase',
			filename,
			code: 'document.addEventListener("keydown", onKeydown, true);',
			errors: 1,
		},
		{
			name: 'a template literal event name',
			filename,
			code: 'el.addEventListener(`keydown`, onKeydown);',
			errors: 1,
		},
		{
			name: 'a bare addEventListener call',
			filename,
			code: "addEventListener('keydown', onKeydown);",
			errors: 1,
		},
		{
			name: 'an onkeydown property',
			filename,
			code: 'document.onkeydown = onKeydown;',
			errors: 1,
		},
		{
			name: 'VueUse useEventListener with and without a target',
			filename,
			code: "useEventListener(window, 'keydown', onKeydown);\nuseEventListener('keydown', onKeydown);",
			errors: 2,
		},
		{
			name: 'VueUse onKeyStroke',
			filename,
			code: "onKeyStroke('j', next);",
			errors: 1,
		},
	],
});
