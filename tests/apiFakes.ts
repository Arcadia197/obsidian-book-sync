// Fakes for the API tests: an HttpFn that replays queued answers and records what was sent, a clock that never
// really waits, and the recorded (anonymized) answers from tests/fixtures/.
import { readFileSync } from "fs";
import type { Clock, HttpFn, HttpRequest, HttpResponse } from "../src/api/http";

export function fixture(name: string): string {
	return readFileSync(`tests/fixtures/${name}`, "utf8");
}

interface Recorded {
	status: number;
	headers?: Record<string, string>;
	body: unknown;
}

const hardcoverAnswers = JSON.parse(fixture("hardcover.json")) as Record<string, Recorded>;

/** A recorded Hardcover answer by name (see tests/fixtures/hardcover.json) */
export function hardcover(name: string): HttpResponse {
	const answer = hardcoverAnswers[name];
	if (!answer) {
		throw new Error(`no fixture "${name}"`);
	}
	return { status: answer.status, headers: answer.headers ?? {}, text: JSON.stringify(answer.body) };
}

export function jsonResponse(body: unknown, status = 200): HttpResponse {
	return { status, headers: { "content-type": "application/json" }, text: JSON.stringify(body) };
}

export function textResponse(text: string, status = 200): HttpResponse {
	return { status, headers: {}, text };
}

export function fakeHttp(...answers: HttpResponse[]) {
	const queue = [...answers];
	const requests: HttpRequest[] = [];
	const http: HttpFn = async (request) => {
		requests.push(request);
		const next = queue.shift();
		if (!next) {
			throw new Error(`unexpected request to ${request.url}`);
		}
		return next;
	};
	/** The JSON body of the n-th request */
	const body = (n: number) => JSON.parse(requests[n].body ?? "null");
	return { http, requests, body, pending: () => queue.length };
}

export function fakeClock(): Clock & { sleeps: number[] } {
	let now = 1_000_000;
	const sleeps: number[] = [];
	return {
		sleeps,
		now: () => now,
		sleep: async (ms) => {
			sleeps.push(ms);
			now += ms;
		},
	};
}
