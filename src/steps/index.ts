// Every step by id, in pipeline order (sync_books.py): backlog (pull -> link -> push), labels, archive
// (promote -> reconcile -> finished). Every apply gets a WritingApplyContext; only push and labels use its writer.

import type { StepId } from "../core/changes";
import { addBook } from "./addBook";
import type { Step, WritingApplyContext } from "./context";
import { finished } from "./finished";
import { labels } from "./labels";
import { linkIds } from "./linkIds";
import { promote } from "./promote";
import { pullGoodreads } from "./pullGoodreads";
import { push } from "./push";
import { reconcile } from "./reconcile";

type AnyStep = Step<unknown, WritingApplyContext>;

export const STEPS: Record<StepId, AnyStep> = {
	"backlog/pullGoodreads": pullGoodreads as AnyStep,
	"backlog/linkIds": linkIds as AnyStep,
	"backlog/push": push as AnyStep,
	"labels/sync": labels as AnyStep,
	"archive/promote": promote as AnyStep,
	"archive/reconcile": reconcile as AnyStep,
	"archive/finished": finished as AnyStep,
	"backlog/addBook": addBook as AnyStep,
};
