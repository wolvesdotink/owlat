declare module '*.vue' {
	import type { DefineComponent } from 'vue';
	const component: DefineComponent<object, object, unknown>;
	export default component;
}

// Stylesheets imported for their side effect (EmailBuilder.vue, EmailPreviewer.vue);
// the host's bundler turns them into CSS that loads with the importing chunk.
declare module '*.css';
