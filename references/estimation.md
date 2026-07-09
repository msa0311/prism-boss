# Estimating `human_minutes_saved`

Recorded **only for agent performers** — the minutes a competent human would
have spent doing the same work the agent just did. Human work is the labor
itself, not a saving, so human records omit this field.

The number is the ROI numerator behind the dashboard's "minutes saved" and its
dollar conversion. It must survive an executive asking "says who?" — so it
claims **labor substitution only**, never downtime cost, revenue impact, or
MTTR-derived business value. Bias conservative: a defensible small number beats
an impressive one.

## Method: size classes, then bounded modifiers

Judge the size of the work from the thread evidence, pick the class, apply at
most the listed modifiers, round to the nearest 5, never exceed the cap.

| Size | Baseline | What it looks like in a thread |
|---|---|---|
| trivial | 5 | a one-line answer, a rubber-stamp, an ack that resolved something |
| small | 15 | a single-file change, a quick triage with an obvious cause, a short report |
| medium | 30 | multi-step investigation, a normal PR with review, a real diagnosis |
| large | 60 | multi-file / multi-system change, a deep investigation, a written analysis with findings |
| xl | 120 (**hard cap**) | a sprawling incident touching many systems, a substantial deliverable |

Modifiers (each justified by something visible in the thread; total still capped):
- **+1 class** if the work clearly involved several distinct steps/tools evidenced in the thread (not one shot).
- **+1 class** if it produced a durable artifact a human would have had to write (a PR, a manifest, a written report), on top of diagnosis.
- **−1 class** for a known repeat: the same `id` (or obviously the same recurring problem) was handled within the last 24 h — the second time is faster for a human too.
- **outcome floor**: `failed` / `rejected` → 0. `no_action_needed` / `needs_human` → cap at `small` (15) — a human would still have looked, but didn't do the full job.

## No double-counting across a chain

A chained work item accrues minutes **per stage for the distinct work of that
stage**, never re-counting earlier stages:
- `incident` (triage) → the diagnosis minutes.
- `change` (the fix PR, same `id`) → the **authoring** minutes only; diagnosis
  was already credited on the `incident` record. Treat the PR as if diagnosis
  were free (it was, on the prior record).
- verify (`maintenance`/`analysis`, same `id`) → the small check only (trivial/small).

## When unsure

Drop a class. If you cannot articulate what a human would concretely have done
instead, record `trivial` (5). The boss may keep learned per-team / per-category
starting points in its memory (e.g. "this team's k8s-triage is usually medium"),
but every estimate stays within these classes and caps and remains defensible
from the thread.
