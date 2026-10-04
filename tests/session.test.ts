import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { ApplyResult, Change, Plan, StepId } from "../src/core/changes";
import { emptyResult } from "../src/core/changes";
import { SyncSession, tally } from "../src/run/session";
import { FULL_SYNC, PHASES, STEP_INFO } from "../src/run/stepInfo";

const change = (id: string, selected = true): Change => ({ id, summary: id, details: [], warnings: [], writesHardcover: false, selected, ready: true, payload: null });

/** A runner whose plans come from `plans` (an Error throws) and whose answers can be held back with `hold` */
function runner(plans: Partial<Record<StepId, Change[] | Error>>) {
	const planned: StepId[] = [];
	const applied: StepId[] = [];
	let held: (() => void) | null = null;
	let holdNext = false;
	return {
		planned,
		applied,
		hold() {
			holdNext = true;
		},
		release() {
			held?.();
			held = null;
		},
		async plan(id: StepId): Promise<Plan> {
			planned.push(id);
			if (holdNext) {
				holdNext = false;
				await new Promise<void>((resolve) => (held = resolve));
			}
			const changes = plans[id] ?? [];
			if (changes instanceof Error) {
				throw changes;
			}
			return { step: id, changes: changes.map((c) => ({ ...c })), notes: [`notes of ${id}`] };
		},
		async apply(plan: Plan): Promise<ApplyResult> {
			applied.push(plan.step);
			await new Promise((resolve) => setTimeout(resolve, 5));
			return { ...emptyResult(), applied: plan.changes.filter((c) => c.selected).map((c) => c.id) };
		},
	};
}

test("step info: every pipeline step is in exactly one phase, in sync_books.py order", () => {
	assert.deepEqual(FULL_SYNC, [
		"backlog/pullGoodreads", "backlog/linkIds", "backlog/push", "labels/sync", "archive/promote", "archive/reconcile", "archive/finished",
	]);
	for (const phase of PHASES) {
		for (const id of phase.steps) {
			assert.equal(STEP_INFO[id].phase, phase.id);
		}
	}
});

test("session: plan, review, apply, next; a double apply writes once", async () => {
	const r = runner({ "backlog/pullGoodreads": [change("a"), change("b", false)], "backlog/linkIds": [change("c")] });
	const session = new SyncSession(["backlog/pullGoodreads", "backlog/linkIds"], r);
	await session.start();
	assert.equal(session.current?.status, "review");
	assert.deepEqual(r.planned, ["backlog/pullGoodreads"], "the next step is planned only after this one");

	const first = session.apply();
	const second = session.apply();
	assert.equal(session.current?.status, "applying");
	await Promise.all([first, second]);
	assert.deepEqual(r.applied, ["backlog/pullGoodreads"]);
	assert.deepEqual(session.current?.result?.applied, ["a"]);
	await session.apply();
	assert.equal(r.applied.length, 1, "an applied step is not applied again");

	await session.next();
	assert.equal(session.current?.id, "backlog/linkIds");
	await session.skip();
	assert.ok(session.finished);
	assert.deepEqual(tally(session).map((t) => [t.status, t.written]), [["applied", 1], ["skipped", 0]]);
});

test("session: nothing ticked means apply does nothing", async () => {
	const r = runner({ "backlog/push": [change("a", false)] });
	const session = new SyncSession(["backlog/push"], r);
	await session.start();
	await session.apply();
	assert.deepEqual(r.applied, []);
	assert.equal(session.current?.status, "review");
});

test("session: steps with nothing to do pass on by themselves, notes kept", async () => {
	const r = runner({ "archive/finished": [change("f")] });
	const session = new SyncSession(["archive/promote", "archive/reconcile", "archive/finished"], r);
	await session.start();
	assert.equal(session.current?.id, "archive/finished");
	assert.deepEqual(session.entries.map((e) => e.status), ["empty", "empty", "review"]);
	assert.deepEqual(session.entries[0].plan?.notes, ["notes of archive/promote"]);
});

test("session: ended halfway, nothing more is planned or applied, a late plan is dropped", async () => {
	const r = runner({ "backlog/pullGoodreads": [change("a")], "backlog/linkIds": [change("b")] });
	const session = new SyncSession(["backlog/pullGoodreads", "backlog/linkIds", "backlog/push"], r);
	await session.start();
	await session.apply();
	r.hold();
	const planning = session.next();
	assert.equal(session.current?.status, "planning");
	session.end();
	r.release();
	await planning;
	assert.equal(session.current?.plan, null, "the plan that came back after end() is dropped");
	await session.apply();
	await session.skip();
	await session.next();
	assert.deepEqual(r.planned, ["backlog/pullGoodreads", "backlog/linkIds"]);
	assert.deepEqual(r.applied, ["backlog/pullGoodreads"]);
});

test("session: a failing plan stops on its step; retry plans again, skip moves on", async () => {
	const plans: Partial<Record<StepId, Change[] | Error>> = { "backlog/push": new Error("No Hardcover token set") };
	const r = runner(plans);
	const session = new SyncSession(["backlog/push", "labels/sync"], r);
	await session.start();
	assert.equal(session.current?.status, "failed");
	assert.equal(session.current?.error, "No Hardcover token set");
	plans["backlog/push"] = [change("p", false)];
	await session.retry();
	assert.equal(session.current?.status, "review");
	await session.skip();
	assert.ok(session.finished, "labels has nothing to do and passes on");
});

test("session: a failing apply is reported as possibly partly written", async () => {
	const r = runner({ "labels/sync": [change("l")] });
	r.apply = async () => {
		throw new Error("Hardcover timed out");
	};
	const session = new SyncSession(["labels/sync"], r);
	await session.start();
	await session.apply();
	assert.equal(session.current?.status, "failed");
	assert.ok(session.current?.applyFailed);
});
