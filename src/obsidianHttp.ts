// The HttpFn for the plugin: Obsidian's requestUrl (no CORS limits, works on mobile). `throw: false` hands every
// status to the API clients, which need 202, 401 and 429 as answers, not exceptions.

import { requestUrl } from "obsidian";
import type { HttpFn } from "./api/http";

export const obsidianHttp: HttpFn = async (request) => {
	const response = await requestUrl({
		url: request.url,
		method: request.method ?? "GET",
		headers: request.headers,
		body: request.body,
		throw: false,
	});
	return { status: response.status, headers: response.headers ?? {}, text: response.text ?? "" };
};
