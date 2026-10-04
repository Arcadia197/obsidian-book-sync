// A local HTTP server standing in for Hardcover, Goodreads and OpenAI. requestUrl runs in Obsidian's main process,
// so CDP interception in the window doesn't see it; a real server on 127.0.0.1 does. Nothing leaves the machine.
import http from "http";

/**
 * `respond({ method, path, headers, body })` -> `{ status, headers?, body }` (body: string, or anything JSON).
 * Returns the server's base URL, every request it got, and close().
 */
export async function startFakeServer(respond) {
	const requests = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const request = { method: req.method, path: req.url, headers: req.headers, body };
			requests.push(request);
			let answer;
			try {
				answer = respond(request);
			} catch (err) {
				answer = { status: 500, body: String(err) };
			}
			const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
			res.writeHead(answer.status, { "Content-Type": "application/json", ...answer.headers });
			res.end(text);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		requests,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}
