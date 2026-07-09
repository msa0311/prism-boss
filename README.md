# prism-boss

A [Prism](https://github.com/lensapp) Agent Skill that turns an agent into a
**team lead ("boss")**: it sits in the Slack channel(s) where your team — worker
agents *and* humans — get things done, passively assesses every completed unit
of work, and serves a live **Grafana dashboard from its own sandbox** so the
team's output and value are measurable and defensible.

No OpenTelemetry, no external collector, no worker instrumentation. The boss
observes the conversation, judges the work (it is the LLM-as-judge, with human
reactions and corrections in-thread as signal), and records structured,
PII-free assessments to a local SQLite database that Grafana reads.

```
team Slack channel(s) ──observe (silent)──► boss assesses a batch of activity
                                              │  reads full threads, verifies PR/CI links
                                              ▼
                          /data/boss/assessments.jsonl (truth) + assessments.db
                                              │
                                Grafana (/apps/grafana) — the Team Work dashboard
```

## What the dashboard shows

Volume and outcomes over time, a **team roster** (each performer — agent or
human — with items, SLA, needs-attention, and estimated human-minutes saved),
breakdowns by work type / category / severity, **work chains** (one work item
tracked across triage → change → verify), a **humans-vs-agents** like-for-like
comparison, and a recent needs-attention feed.

## It's a pure skill — stock prism image

There is no custom image. You run a normal prism-agent sandbox and install this
skill; the boss installs Grafana into its `/data` volume during setup and
serves it through prism's own port via the exposed-apps feature.

### Install to Lens Agents (for an agent with the Lens Agents MCP)

1. `create_sandbox` with the **stock** prism-agent image:

```json
{
  "tool": "create_sandbox",
  "arguments": {
    "projectId": "<projectId>",
    "name": "team-boss",
    "image": "<the published prism-agent image>",
    "command": "./start.sh",
    "env": {
      "SLACK_BOT_TOKEN": "xoxb-…",
      "SLACK_APP_TOKEN": "xapp-…",
      "SLACK_SKIP_BOT_ID_CHECK": "true",
      "AWS_BEARER_TOKEN_BEDROCK": "…"
    },
    "volumes": [{ "mountPath": "/data" }],
    "exposedPorts": [{ "name": "web", "port": 3003, "auth": "private" }],
    "healthCheck": { "type": "http", "http": { "path": "/health", "port": 3003 }, "initialDelaySeconds": 30 }
  }
}
```

`SLACK_SKIP_BOT_ID_CHECK=true` is what lets the boss observe **other** bots'
messages (its own are still skipped, to avoid loops). Egress policy must allow
`dl.grafana.com` and `grafana.com` for the one-time Grafana download (or an
operator pre-drops the tarball into `/data/grafana`).

2. Install this skill and open a chat: **"set yourself up as team lead."** The
   boss runs `scripts/setup-grafana.sh`, exposes Grafana via `expose_app`,
   creates heartbeat triggers on the channels you name, and reports the
   dashboard URL. Invite the boss's Slack bot to those channels and confirm any
   verification code it posts.

3. Open `https://<sandbox-slug>.<ingress-host>/apps/grafana` for the dashboard;
   the prism UI stays at the root of the same URL.

### Local / dev

Point `BOSS_DATA_DIR` at a scratch dir and run the scripts directly with node +
bash; `scripts/setup-grafana.sh` is OS/arch-aware and works on macOS and Linux.
`BOSS_SQLITE_REQUIRE_BASE=<prism>/node_modules` lets the recorder find
`better-sqlite3` outside a container.

## Depends on two prism features (Jira NEXUS-92, NEXUS-93)

The boss composes with two generic prism-agent enhancements tracked in the
`NEXUS` (LENS AGENTS) project:

- **NEXUS-92 — Slack thread reading**: the `slack_read_thread` tool (pull full
  threads before judging), thread context (`channelId`/`threadTs`) in the
  heartbeat batch, and **multiple** heartbeat-trigger channels per agent.
- **NEXUS-93 — Exposed apps**: the `/apps/<name>` reverse proxy and `expose_app`
  tool that serve Grafana on prism's single sandbox port.

The skill degrades gracefully before they land (assess from message snapshots;
Grafana reachable only once exposed-apps ships) — but the full experience needs
both.

## Files

| File | Purpose |
|------|---------|
| `SKILL.md` | The boss's operating manual: setup + assessment behavior. |
| `references/assessment.md` | Record schema, generic work-type set, chaining, evidence + dedup + honesty rules. |
| `references/estimation.md` | The `human_minutes_saved` rubric (agent performers only). |
| `scripts/record-assessment.mjs` | Self-contained recorder → JSONL ledger + SQLite db (`--rebuild` to regenerate). |
| `scripts/setup-grafana.sh` | Install Grafana + SQLite datasource + provisioning + the default dashboard into `/data`. |
| `scripts/ensure-grafana.sh` | Start Grafana if not running (run at the start of every boss run). |
| `assets/team-work.json` | The default Team Work dashboard (boss-editable in `/data/grafana-dashboards`). |

## A note on measuring humans

The boss can assess **any** performer — agent or human — with the same rubric,
which is what makes a real human-vs-agent comparison possible. Assessing named
humans is **workforce monitoring**: in many jurisdictions (e.g. the EU under
GDPR, and where works councils apply) that is a compliance matter, not a toggle.
Only enable human assessment **with the team's knowledge and consent**, prefer
aggregate presentation, and default to agents-only (the dashboard ships with the
performer-kind filter pre-set to `agent`). This is a deliberate choice for the
operator, not a default behavior.

## License

Apache-2.0
