// @vitest-environment node
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as h3 from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";

const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
					server.closeAllConnections();
				}),
		),
	);
	vi.unstubAllGlobals();
});

describe("auth proxy redirects", () => {
	it("returns the upstream redirect and session cookies without fetching the callback", async () => {
		const callbackRequest = vi.fn();
		const callbackOrigin = await listen(
			createServer((request, response) => {
				callbackRequest(request.headers);
				response.end("private callback response");
			}),
		);
		const location = `${callbackOrigin}/callback?error=INVALID_TOKEN`;
		const upstreamRequest = vi.fn();
		const upstreamOrigin = await listen(
			createServer((request, response) => {
				upstreamRequest(request.url, request.headers);
				response.writeHead(302, {
					Location: location,
					"Set-Cookie": [
						"better-auth.session_token=new-session; Domain=convex.example; Path=/; HttpOnly; SameSite=Lax",
						"better-auth.session_data=new-data; Path=/; HttpOnly; SameSite=Lax",
					],
				});
				response.end();
			}),
		);
		for (const name of [
			"defineEventHandler",
			"createError",
			"readRawBody",
			"getHeaders",
			"getHeader",
			"getRequestIP",
			"appendResponseHeader",
			"setHeader",
			"setResponseStatus",
		] as const) {
			vi.stubGlobal(name, h3[name]);
		}
		vi.stubGlobal("useRuntimeConfig", () => ({
			convexSiteUrlInternal: upstreamOrigin,
			public: {},
		}));
		const { default: handler } = await import("../[...]");
		const app = h3.createApp().use(handler);
		const proxyOrigin = await listen(createServer(h3.toNodeListener(app)));
		const path = "/api/auth/verify-email?token=invalid&callbackURL=" + encodeURIComponent(location);
		const response = await fetch(proxyOrigin + path, {
			redirect: "manual",
			headers: { "Better-Auth-Cookie": "desktop-session=secret" },
		});

		expect(upstreamRequest).toHaveBeenCalledOnce();
		expect(upstreamRequest.mock.calls[0]?.[0]).toBe(path);
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(location);
		expect(response.headers.getSetCookie()).toEqual([
			"better-auth.session_token=new-session; Path=/; HttpOnly; SameSite=Lax",
			"better-auth.session_data=new-data; Path=/; HttpOnly; SameSite=Lax",
		]);
		expect(await response.text()).toBe("");
		expect(callbackRequest).not.toHaveBeenCalled();
	});
});
