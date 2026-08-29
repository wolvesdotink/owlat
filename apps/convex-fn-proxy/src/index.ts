import { createServer } from 'node:http';
import { createProxyHandler, PORT, resolveConfig } from './proxy.js';

// Fail closed at boot: resolveConfig throws if the upstream URL, the injected
// admin key, or the worker token is missing.
const config = resolveConfig();
const server = createServer(createProxyHandler(config));

server.listen(PORT, '0.0.0.0', () => {
	console.info(`Convex function-allowlist proxy listening on port ${PORT}`);
});
