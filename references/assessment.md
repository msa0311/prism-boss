# Assessment model (how the boss records work)

The boss watches a team's Slack channel(s) and turns **completed units of work**
into structured **assessment records**. This file is the contract: the record
schema, the generic work-type set, and the rules for judging. It is
domain-neutral — the same model measures an SRE team, a support team, a data
team, or a mixed human+agent team. Domain specifics live in the free-text
`category`, a per-team vocabulary the boss curates in its own memory.

## What counts as a unit of work

One record per **delivered result a teammate would recognize as work**: an
incident handled, a PR opened, a report delivered, a question answered, a
routine chore done. Judge from the thread as a whole, not per message.

**Not** a unit of work: an individual chat message, a sub-step of a larger
task, an acknowledgement, small talk, or a still-in-progress thread. When in
doubt, wait — a later batch will show the finished result. Recording chatter is
the one thing that destroys the dashboard's credibility.

## The record

Written by `scripts/record-assessment.mjs` (one `shell_exec` call per unit).
Input JSON:

```json
{
  "type": "incident",
  "outcome": "resolved",
  "id": "payments-api-crashloop-2026-07-09",
  "performer_id": "sre-agent",
  "performer_name": "SRE Agent",
  "performer_kind": "agent",
  "severity": "high",
  "category": "k8s-triage",
  "detected_at": "2026-07-09T14:03:00Z",
  "duration_ms": 480000,
  "human_minutes_saved": 30,
  "channel": "sre-alerts",
  "attrs": {
    "evidence.verified": true,
    "pr.url": "https://github.com/acme/gitops/pull/42",
    "pr.state": "open"
  },
  "summary": "one neutral sentence, no secrets"
}
```

| Field | Type | Meaning | Required |
|---|---|---|---|
| `type` | enum | generic work type (below) | yes |
| `outcome` | enum | `resolved` \| `delivered` \| `mitigated` \| `no_action_needed` \| `needs_human` \| `escalated` \| `failed` \| `rejected` | yes |
| `id` | string | **stable fingerprint of the underlying work item** — the same problem/task produces the same id across stages (chaining) and across re-observations (dedup) | yes |
| `performer_id` | string | stable id of who did the work (boss maps sender → id in memory) | yes |
| `performer_name` | string | display name | yes |
| `performer_kind` | enum | `agent` \| `human` | yes |
| `severity` | enum | `critical` \| `high` \| `medium` \| `low` \| `info` | recommended |
| `category` | string | per-team domain class (boss-curated vocabulary), e.g. `k8s-triage`, `gitops-pr`, `customer-ticket`, `data-pipeline` | recommended |
| `detected_at` | ISO 8601 / epoch ms | when the work item began (alert time, request time); `duration_ms` auto-derives from it | recommended |
| `duration_ms` | int | detection → done | auto/opt |
| `human_minutes_saved` | number | estimate per `estimation.md`; **agent performers only** | agent only |
| `channel` | string | Slack channel where observed | recommended |
| `attrs` | object | extension facts — primitives only, dotted keys, ≤128 chars each, **no secrets/PII/tokens/log dumps** | optional |
| `summary` | string | one neutral sentence for the dashboard's feed; **no message bodies, no credentials** | optional |

### Generic work types

Keep to this set; put the domain flavor in `category`. Add a new type only if a
team genuinely produces recurring work none of these fit (stability matters —
the dashboard groups by this string forever).

| `type` | Use for | Example `category` values |
|---|---|---|
| `incident` | something broke and a teammate handled it | `k8s-triage`, `pager`, `outage` |
| `change` | a change was proposed/shipped — PR, config, deploy, artifact | `gitops-pr`, `iac`, `release` |
| `analysis` | investigation / report / answer / recommendation delivered | `root-cause`, `cost-report`, `forecast` |
| `support` | helped a person (answered, unblocked, guided) | `customer-ticket`, `internal-help` |
| `maintenance` | routine upkeep — patching, cleanup, rotations | `dependency-bump`, `cert-rotation` |
| `task` | any other discrete completed work | anything |
| `boss.setup` | reserved — the boss's own setup smoke-test | — |

## Outcome → status buckets (for SLA)

The dashboard rolls outcomes into three buckets:
- **ok**: `resolved`, `delivered`, `mitigated`, `no_action_needed`
- **attention**: `needs_human`, `escalated`, `rejected`
- **failed**: `failed`

Team SLA = ok / (ok + failed). Attention items are neither success nor failure —
they are honest "a human still had to step in" signals.

## Chaining (one work item, several stages)

The `id` fingerprints the **problem/task**, not the stage. A crashloop that is
first triaged, then fixed by a PR, then verified after merge is three records
with the **same `id`** and different `type` (`incident` → `change` →
`maintenance`/`analysis` verify). The dashboard's "work chains" view groups by
`id`; correlation key is `id`, stage key is `(id, type)`.

## Evidence verification (before recording)

When a thread claims work backed by a link — a GitHub PR/issue/commit, a CI run,
a dashboard — **follow the link and check the claim** before recording:
- GitHub: `gh pr view <url> --json state,title,files` / `gh api` (token is
  deployment-specific), or plain `curl` for public URLs.
- Does the PR exist? Open/merged/closed? Does it touch what the report claims?
- Stamp the result: `attrs["evidence.verified"] = true|false`, plus facts like
  `attrs["pr.state"]`. A `change` whose link 404s → `outcome: failed`,
  `evidence.verified: false`. A later observed merge upgrades the chain (a new
  same-`id` record).
- **Never block on verification.** Unreachable (egress/auth) → record anyway
  with `evidence.verified: false` and move on.

## Dedup discipline

Threads arrive across several heartbeat batches. Before recording, check the
ledger for the same `(type, id)` within the last 24 h
(`jq` over `/data/boss/assessments.jsonl`, or `record-assessment.mjs` warns on a
same-day `(type,id)` collision). Only record once the work is **complete**; a
later, more advanced stage of the same `id` is a new record with a new `type`,
not a duplicate.

## Humans and agents, one rubric

The boss measures **whoever did the work** — human or agent — with the same
types, outcomes, and severity. The only asymmetry: `human_minutes_saved` is
recorded **only for `performer_kind: agent`** (an agent's work substitutes human
labor; a human's work is the labor). This is what makes a real, like-for-like
human-vs-agent comparison possible. See the workforce-monitoring note in the
README before enabling human assessment.

## Honesty rules

- Assessments are the boss's **judgment from conversation evidence** — not
  ground truth. When a thread is ambiguous, use `outcome: needs_human` rather
  than guessing a clean result.
- Never invent an `id`, a performer, or an outcome not supported by the thread.
- Never record secrets, credentials, tokens, customer data, or raw log/message
  bodies — records are ids, enums, numbers, and one neutral summary sentence.

---

## Appendix — worked example (non-normative)

An SRE team channel. Not a spec — just how the generic model maps to one domain.

- A worker agent posts a triage report for a crashlooping pod →
  `type: incident`, `category: k8s-triage`, `outcome: resolved` (root cause
  found) or `needs_human`, `severity` from the report, `id:
  "payments-api-crashloop-2026-07-09"`, `performer_kind: agent`, minutes from
  the rubric.
- The same agent later posts a GitOps PR link fixing it → **same `id`**,
  `type: change`, `category: gitops-pr`; the boss `gh pr view`s the link,
  stamps `attrs["pr.state"]` and `evidence.verified`.
- A human replies "merged, pods healthy" → same `id`, `type: maintenance`
  (verify), `performer_kind: human`, no `human_minutes_saved`.
- The dashboard's work-chains view shows all three under one `id`; the roster
  credits the agent's minutes; the humans-vs-agents panel compares like for like.
