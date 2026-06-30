import { createServer } from 'node:http';
import { buildRequestListener, PORT } from './server.js';

const server = createServer(buildRequestListener());

server.listen(PORT, '0.0.0.0', () => {
	console.info(`Updater sidecar listening on port ${PORT}`);
});
