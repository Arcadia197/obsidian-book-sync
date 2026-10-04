// Builds every API client from the settings. Called per run, so a key changed in the settings applies right away.

import type { BookSyncSettings } from "../settings";
import { GoodreadsClient } from "./goodreads";
import { createHardcover, HardcoverReader, HardcoverWriter } from "./hardcover";
import type { Clock, HttpFn } from "./http";
import { OpenAiClient } from "./openai";

/** Where requests go; the e2e test points them at local fake servers */
export interface Endpoints {
	hardcover?: string;
	openai?: string;
	/** Base of Goodreads book pages, e.g. "https://www.goodreads.com" */
	goodreads?: string;
	/** OpenAI's model list, for the key test */
	openaiModels?: string;
	/** Hardcover pacing per request, only for the e2e test's fake server (the real API needs the default 1.1s) */
	hardcoverIntervalMs?: number;
}

export interface Clients {
	/** For plan(): no mutate() */
	hardcover: HardcoverReader;
	/** For apply() only */
	hardcoverWriter: HardcoverWriter;
	goodreads: GoodreadsClient;
	openai: OpenAiClient;
}

export function createClients(settings: BookSyncSettings, http: HttpFn, endpoints: Endpoints = {}, clock?: Clock): Clients {
	const { reader, writer } = createHardcover({
		token: settings.hardcoverToken,
		http,
		endpoint: endpoints.hardcover,
		clock,
		intervalMs: endpoints.hardcover ? endpoints.hardcoverIntervalMs : undefined,
	});
	const goodreadsBase = endpoints.goodreads?.replace(/\/+$/, "");
	return {
		hardcover: reader,
		hardcoverWriter: writer,
		goodreads: new GoodreadsClient({
			http,
			clock,
			bookUrl: goodreadsBase ? (id) => `${goodreadsBase}/book/show/${id}` : undefined,
		}),
		openai: new OpenAiClient({ apiKey: settings.openaiKey, model: settings.openaiModel, http, url: endpoints.openai, modelsUrl: endpoints.openaiModels }),
	};
}
