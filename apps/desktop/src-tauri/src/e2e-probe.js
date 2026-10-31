// Renderer probe for e2e-fixture builds, injected by e2e.rs before the page's
// own scripts in the main frame of every window. It emits through the event
// plugin the default capability already grants (`core:event:default`), so the
// instrumentation needs no IPC permission of its own.
(() => {
	const send = (payload) => {
		try {
			window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'owlat-e2e', payload });
		} catch {
			// No IPC bridge (a plain browser): nothing to report to.
		}
	};
	window.addEventListener(
		'error',
		(event) => {
			const target = event.target;
			if (target && target !== window && (target.src || target.href)) {
				send({
					event: 'renderer-error',
					kind: 'resource',
					detail: String(target.src || target.href),
				});
				return;
			}
			send({
				event: 'renderer-error',
				kind: 'uncaught',
				detail: `${event.message} (${event.filename}:${event.lineno})`,
			});
		},
		true
	);
	window.addEventListener('unhandledrejection', (event) => {
		const reason = event.reason;
		send({
			event: 'renderer-error',
			kind: 'unhandled-rejection',
			detail: String((reason && reason.stack) || reason),
		});
	});
	// The web app's error handler plugin catches Vue component errors and Nuxt
	// app errors without rethrowing, so neither of the listeners above sees them
	// and the page can mount around a component that failed. The plugin
	// announces each one with this event.
	window.addEventListener('owlat:renderer-error', (event) => {
		const detail = event.detail || {};
		send({
			event: 'renderer-error',
			kind: 'vue',
			detail: `${detail.source}: ${detail.message}`,
		});
	});
	// Mount is detected with a MutationObserver rather than a timer: the welcome
	// page's address field inside the mounted Vue root, with the page title set.
	let reported = false;
	const check = () => {
		if (reported) return;
		const root = document.getElementById('__nuxt');
		if (!root || !root.__vue_app__ || !root.querySelector('input')) return;
		if (!location.pathname.startsWith('/desktop/welcome') || !document.title) return;
		reported = true;
		observer.disconnect();
		send({ event: 'mounted', path: location.pathname, title: document.title });
	};
	const observer = new MutationObserver(check);
	observer.observe(document, { childList: true, subtree: true, characterData: true });
})();
