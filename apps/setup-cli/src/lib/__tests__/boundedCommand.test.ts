import { once } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBounded, type CommandOptions } from '../boundedCommand';

describe('runBounded', () => {
	const node = process.execPath;
	const options = (overrides: Partial<CommandOptions>): CommandOptions => ({
		cwd: process.cwd(),
		timeoutMs: 30_000,
		maxBytes: 1024,
		keep: 'head',
		...overrides,
	});
	const print =
		'for (let i = 0; i < 2000; i++) console.log("line " + i); console.error("on stderr");';

	it('keeps the head of an oversized output and reports the cut', async () => {
		const result = await runBounded(node, ['-e', print], options({ maxBytes: 64 }));
		expect(result.code).toBe(0);
		expect(result.truncated).toBe(true);
		expect(result.output.length).toBe(64);
		expect(result.output.startsWith('line 0\n')).toBe(true);
		expect(result.output).not.toContain('on stderr');
	});

	it('keeps the tail, starting at a whole line', async () => {
		const result = await runBounded(node, ['-e', print], options({ maxBytes: 64, keep: 'tail' }));
		expect(result.truncated).toBe(true);
		expect(result.output.length).toBeLessThanOrEqual(64);
		expect(result.output).toMatch(/^line \d+\n/);
		expect(result.output.endsWith('line 1999\n')).toBe(true);
	});

	it('captures stderr too when asked', async () => {
		const result = await runBounded(
			node,
			['-e', 'console.error("only stderr")'],
			options({ mergeStderr: true })
		);
		expect(result).toMatchObject({ code: 0, output: 'only stderr\n', truncated: false });
	});

	it('reports a program that cannot start as 127', async () => {
		const result = await runBounded('owlat-no-such-program', [], options({}));
		expect(result).toEqual({ code: 127, output: '', truncated: false, timedOut: false });
	});

	it('passes the exit code through', async () => {
		const result = await runBounded(node, ['-e', 'process.exit(3)'], options({}));
		expect(result).toMatchObject({ code: 3, truncated: false, timedOut: false });
	});

	describe('a command that leaves a process holding its output pipes', () => {
		// Like `docker` and its compose plugin: the command starts a child that
		// inherits stdout/stderr, connects back here once it runs, and lives until
		// it is killed. Its socket closing is the proof that it was.
		let server: Server | undefined;
		const sockets: Socket[] = [];
		afterEach(() => {
			vi.useRealTimers();
			for (const socket of sockets.splice(0)) socket.destroy();
			server?.close();
			server = undefined;
		});

		async function listen(): Promise<number> {
			server = createServer((socket) => sockets.push(socket));
			server.listen(0, '127.0.0.1');
			await once(server, 'listening');
			return (server.address() as AddressInfo).port;
		}

		function command(port: number, leaderExits: boolean): string[] {
			const plugin = [
				`const socket = require('node:net').connect(${port}, '127.0.0.1');`,
				"socket.on('connect', () => process.send('running'));",
				"socket.on('close', () => process.exit(0));",
				'setInterval(() => {}, 1 << 30);',
			].join(' ');
			const leader = [
				"const plugin = require('node:child_process').spawn(process.execPath,",
				`['-e', ${JSON.stringify(plugin)}], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });`,
				"plugin.on('message', () => {",
				"console.log('plugin running');",
				leaderExits ? 'process.exit(0);' : '',
				'});',
				'setInterval(() => {}, 1 << 30);',
			].join(' ');
			return ['-e', leader];
		}

		async function pluginConnected(): Promise<Socket> {
			const [socket] = (await once(server!, 'connection')) as [Socket];
			return socket;
		}

		it('kills the whole process group at the deadline and settles', async () => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			const port = await listen();
			const connected = pluginConnected();
			const result = runBounded(node, command(port, false), options({ timeoutMs: 5_000 }));
			const plugin = await connected;
			const pluginGone = once(plugin, 'close');
			vi.advanceTimersByTime(5_000);
			expect(await result).toMatchObject({ timedOut: true });
			await pluginGone;
		});

		it('reaps what the command left behind when it exits, without waiting for the deadline', async () => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			const port = await listen();
			const connected = pluginConnected();
			const result = runBounded(node, command(port, true), options({ timeoutMs: 5_000 }));
			const pluginGone = once(await connected, 'close');
			// No timer is advanced: the run settles once the leftover process is gone.
			expect(await result).toEqual({
				code: 0,
				output: 'plugin running\n',
				truncated: false,
				timedOut: false,
			});
			await pluginGone;
		});
	});
});
