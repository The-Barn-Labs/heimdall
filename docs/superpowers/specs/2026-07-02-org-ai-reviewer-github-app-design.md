# Org-wide AI PR Reviewer via GitHub App + inline comments — design

**Date:** 2026-07-02 · **Revised:** 2026-07-03 (v2 — adversarial review folded in)
**Status:** Approved design, hardened. Ready for implementation plan.
**Scope:** Sub-project #2 of 3 (see §1). Turns File Valet's proven single-repo `ai-pr-review.yml`
into an org-wide reviewer that runs under a GitHub App identity and posts **line-anchored inline
review comments**. App registration is a prerequisite folded in (§3). The Hermes token broker is a
separate follow-on spec.

> **v2 changelog** — a three-skeptic adversarial review (verified against GitHub docs) found three
> design-breaking issues and nine gaps. Material changes from v1: a new **Security model** (§5)
> closing a fork-head secret-exfil path; **minimal-scoped** token minting (was full-union); a
> **working de-spam** mechanism (the v1 "dismiss review" step is impossible for `COMMENT` reviews);
> resolved **versioning** semantics; an explicit **cutover** step; a hardened **JSON contract**;
> pinned **line-anchoring** rules; **cost + concurrency + timeout** controls; a real **write-access**
> auth check; and two ex-"open questions" promoted to **blocking prerequisites**.

---

## 1. Decomposition (why this is one spec of three)

The larger idea ("a GitHub App that reviews every PR in the org, posts inline comments, and mints
custom tokens for Hermes agents") is three sub-projects sharing only the **App registration**:

1. **The shared GitHub App** — registered once, private key as org secret, union permission set.
   *Prerequisite, folded into §3.*
2. **Org-wide reviewer + inline comments** — *this spec.* The priority.
3. **Hermes token broker (bonus)** — same App mints scoped installation tokens for Hermes agents.
   *Separate spec; shares only §3.*

Build the reviewer first: it proves the App end-to-end; Hermes then reuses a battle-tested App.

---

## 2. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Compute model | Reusable workflow (`workflow_call`) + App-minted token | Reuses the validated `claude -p`/Go recipe; one source file; no server. |
| Command syntax | `@heim-dall <command>` mention style | Namespaces cleanly, @-mentionable, no `/` collision. |
| Reusable-workflow home | Dedicated `heimdall` repo | Versioned releases, clean ownership, keeps org `.github` uncluttered. |
| **Versioning (revised)** | Immutable `@vX.Y.Z` tags **+ a moving major alias `@v1`**; **callers pin the moving `@v1`** | Resolves the v1 contradiction: propagate a fix = edit `heimdall` + move `@v1`; callers roll forward automatically **within** the major; a breaking change cuts `@v2` so nothing silently breaks across majors. One-file propagation *and* a stability boundary. |
| Review verdict | `event: COMMENT` (never `REQUEST_CHANGES`) | Reviewer informs; never blocks merge. |
| Hermes | Separate spec; **union-permission the App now** | App permission changes need admin re-approval on every install. |

---

## 3. The shared GitHub App (prerequisite)

Register one org-owned GitHub App — proposed **`heim-dall`** (identity `heim-dall[bot]`).

**Permissions — request the union up front** (reviewer uses a subset; the rest reserved for Hermes so
a later permission bump doesn't force admin re-approval across every install):

| Permission | Level | Used by |
|---|---|---|
| Pull requests | Read & Write | Reviewer (reviews + inline comments) |
| Contents | Read & Write | Reviewer (Read only) · Hermes (Write) |
| Metadata | Read | Both (mandatory) |
| Issues | Read & Write | Reviewer (comment fallback) |
| Checks | Write | Reviewer (optional summary Check Run) |
| Actions | Read & Write | Hermes (reserved) |
| Deployments | Read & Write | Hermes (reserved) |

**Registered union ≠ minted scope.** The App is *registered* with the union, but each in-workflow
token **mint is downscoped** to only what that run needs (§5.3). The reviewer never holds
Contents:write / Actions / Deployments.

**Events:** `pull_request`, `issue_comment` — consumed via Actions triggers, not a webhook server.
**Secrets:** App ID (`HEIMDALL_APP_ID`) + private key (`HEIMDALL_PRIVATE_KEY`) as **org-level**
Actions secrets, alongside `OPENCODE_GO_KEY`. Installed org-wide.

---

## 4. Architecture

```
heimdall repo (dedicated, versioned)
└── .github/workflows/ai-pr-review.yml   ← reusable: on: workflow_call
                                            (the entire reviewer lives here, once)

each target repo (File Valet, …)
└── .github/workflows/ai-review.yml       ← caller (~15 lines):
      on: pull_request [opened, ready_for_review, reopened]
          issue_comment [created]
          workflow_dispatch
      concurrency: ai-review-${{ pr number }}   # cancel-in-progress
      jobs: review:
        uses: <org>/heimdall/.github/workflows/ai-pr-review.yml@v1   # moving major alias
        secrets: inherit
```

Propagate an improvement = edit the one file in `heimdall`, cut `@vX.Y.Z`, move the `@v1` alias to
it. Callers pinned to `@v1` pick it up; a breaking change cuts `@v2` and callers migrate deliberately.

---

## 5. Security model (new in v2 — the load-bearing section)

The v1 design added a comment-command trigger without reckoning that it runs **privileged** (base-repo
context, org secrets, a minted token). Combined with checking out untrusted PR **head** code and a
prompt that reads the head's `CLAUDE.md`, that reintroduced a `pull_request_target`-class
exfiltration hole. This section closes it. **These rules are mandatory, not optional hardening.**

### 5.1 Trust boundary: never run privileged against untrusted head

A run is **privileged** iff it has the org secrets + minted token (needed to post as the App). A run
is **untrusted** iff it will check out code from a fork / an unknown author.

- **Same-repo PRs** (head repo == base repo): privileged review allowed.
- **Fork PRs**: the `pull_request` trigger already yields **no org secrets** on forks → the reviewer
  **soft-skips** (green, not red), exactly as today. This is intentional and documented (§9), not a
  bug. We do **not** use `pull_request_target`, and we do **not** add a privileged fork path.
- **`issue_comment` command path**: gate to **same-repo, non-fork PRs only**. If the PR head is a
  fork, reply "external PRs are reviewed automatically without elevated access; re-run from a branch
  in this repo for a full review" and exit **before** minting a token or checking out head.

### 5.2 Command authorization (real write-access check)

`author_association` does **not** imply write access (a read-only MEMBER or outside COLLABORATOR
passes it — verified against GitHub's GraphQL enum). Authorize via the actual permission:

```
gh api repos/$REPO/collaborators/$ACTOR/permission --jq '.permission'   # allow ∈ {write, admin}
```

Unauthorized → one-line reply + exit. Unknown command → ignore.

### 5.3 Minimal-scope token mint (not the union)

Mint with explicit `permission-*` inputs so the reviewer token carries **only**:
`permission-pull-requests: write`, `permission-contents: read`, `permission-issues: write`,
`permission-checks: write`. No Contents:write / Actions / Deployments. A leaked reviewer token then
can't push commits, rewrite workflows, or deploy.

### 5.4 Prompt-injection containment

The BASE-ref styleguide guard (v1) does **not** cover the diff, the comment body, or the head's
`CLAUDE.md` — all untrusted. Defenses:

- **Confine `Read`** to the workspace (repo tree). The reviewer must not `Read` absolute paths
  (`/proc/self/environ`, `~/.config`, …). Enforce by running in a clean container/workdir and, where
  possible, restricting the tool's roots; at minimum the prompt forbids reading outside the repo and
  the post-processor rejects any finding referencing an out-of-tree path.
- **No secrets in the model's environment.** Do not export `OPENCODE_GO_KEY` (or the token) into the
  `claude -p` step's shell env beyond what the CLI needs; keep them in steps that don't run model
  tool-use where feasible. The published review is a public channel — assume anything the model can
  read can be exfiltrated, and keep secrets out of its reach.
- **Treat `explain <topic>` as untrusted text**, never as instructions to the workflow.

### 5.5 TOCTOU: pin the reviewed SHA

Authorization is evaluated on the comment, but head can advance before checkout. Capture
`HEAD_SHA` at command time (`gh pr view --json headRefOid`), check out **that SHA**, and if the live
head has moved past it, refuse (or re-review only the pinned SHA). Prevents "authorize benign, review
malicious."

---

## 6. Trigger + command gating

Run the job only when:

- `pull_request` action ∈ {`opened`, `ready_for_review`, `reopened`}, **or**
- `workflow_dispatch`, **or**
- `issue_comment` on a **PR** (`.issue.pull_request` present) that passes §5.1 (same-repo) **and**
  §5.2 (write/admin) **and** whose body matches a command.

Never `synchronize` — no per-push reviews. First step is a cheap body-match guard (issue_comment
fires on every comment) that exits fast on non-commands.

| Command | Action |
|---|---|
| `@heim-dall review` | Default review (engine auto-selected by sensitive-path detection) |
| `@heim-dall review deep` | Force `qwen3.7-max` — **subject to cost gate §8** |
| `@heim-dall explain <topic>` | Q&A reply about the diff (untrusted text; no findings) |

---

## 7. Inline comments (the core feature)

One **GitHub Review** (`POST .../pulls/{n}/reviews`) with a summary `body` + line-anchored
`comments[]`, `event: COMMENT`.

**Model output contract** — structured JSON, hardened for reliability (§7 post-processing):

```json
{
  "summary": "markdown verdict + coverage + counts",
  "findings": [
    { "path": "src/db/x.ts", "line": 42, "start_line": 40, "side": "RIGHT",
      "severity": "High", "category": "Security",
      "body": "markdown; may include a ```suggestion block",
      "confidence": "High" }
  ]
}
```

### 7.1 Line-anchoring rules (pinned — were ambiguous in v1)

- The model **must** emit **new-file, RIGHT-side line numbers** (post-change numbering) for all
  findings. Deleted-line (LEFT) comments are out of scope for v1 — fold any such finding into the
  summary.
- Multi-line invariants the post-processor enforces: `start_line < line`, identical `side`, both
  endpoints inside a diff hunk. Violators are folded into the summary, never sent (avoids 422s).

### 7.2 Deterministic post-processing (never trust the model on API rules)

1. **Parse robustly.** `--output-format json` returns an envelope whose `.result` is a **string**;
   that string must parse as our object (double-parse). Before parsing: strip ```` ```json ```` fences
   and any pre/post prose; then `JSON.parse`. Validate enums (`side`, `severity`, `confidence`).
2. **Per-finding validation, not all-or-nothing.** Each finding is validated independently:
   in-hunk + valid enums → inline comment; out-of-diff / invalid → folded into summary. A single bad
   finding never nukes the whole review (v1's fallback did). Only a **total** parse failure triggers
   the §9 legacy fallback.
3. **Suggested changes** (` ```suggestion `) gated to `confidence: High`.
4. **Verdict** always `COMMENT`.

### 7.3 De-spam (revised — v1's mechanism was inoperative)

`COMMENT` reviews **cannot be dismissed** — the dismiss endpoint only accepts APPROVED /
CHANGES_REQUESTED (verified against GitHub docs). So on a re-request we **minimize the App's prior
inline comments** via the GraphQL `minimizeComment` mutation (`classifier: OUTDATED`), and
**upsert the summary** via the existing marker (`<!-- ai-pr-review-go -->`) — update-in-place, so the
summary never duplicates. Given re-reviews are rare and explicit, that fully controls noise.

### 7.4 Optional (later tag): summary as a **Check Run** instead of review body — keeps the PR
conversation clean and auto-clears on new commits. Deferred past `@v1`.

---

## 8. Cost + concurrency + timeout controls (new in v2)

- **Concurrency:** caller sets `concurrency: ai-review-<pr>` with `cancel-in-progress: true`, so an
  `opened` auto-review and a near-simultaneous command can't produce overlapping runs (which would
  race the minimize-then-upsert in §7.3).
- **Timeout:** `timeout-minutes: 15` on the job — a hung `claude -p` can't burn minutes indefinitely.
- **`review deep` gate:** forcing `qwen3.7-max` requires write/admin (already via §5.2) **and** is
  rate-limited to N/day/PR (simple check against prior bot comments' timestamps). Sensitive-path
  **auto**-escalation stays (it's bounded by who can trigger at all), but `deep` on demand is the
  spammable vector, so it's the one gated.
- **Path skips:** caller-level ignore for lockfiles / generated / vendored dirs.

---

## 9. Data flow + error handling

1. Trigger fires → resolve + validate PR number (numeric guard, existing) → **§5 gates**
   (same-repo? authorized? pin HEAD_SHA) → **mint minimal-scope token** (§5.3).
2. Checkout the **pinned** head SHA (with the `refs/pull/N/head` fallback for merged/deleted
   branches, existing); capture `pr-review.diff`.
3. Read `.ai-review/styleguide.md` **from BASE ref only** (`git show origin/$BASE:…`) — injection
   guard, existing.
4. Detect sensitive paths (existing regex) → pick engine (`qwen3.7-plus` / `qwen3.7-max`, or forced
   by gated `review deep`).
5. `claude -p` high-recall prompt → JSON (retry loop, max 2, gated backoff + empty-`.result` guard,
   existing).
6. Robust parse + **per-finding** validation (§7.2) → build Reviews API payload.
7. §7.3 de-spam (minimize prior inline + upsert summary) → POST the review.

**Preserved hardening:** empty-diff / missing-key soft-skip; retry loop + empty-guard; merged/deleted
checkout fallback; BASE-ref styleguide; sensitive-path escalation.
**Legacy fallback:** on a **total** JSON-parse failure, post the single marker-upserted markdown
summary (today's behavior) — inline comments are then a strict enhancement, and a full parse failure
degrades gracefully rather than losing the review.

---

## 10. Rollout + testing (versioning-aware; no chicken-and-egg)

A caller can reference the reusable workflow by **branch/SHA** (`@main`) to exercise
`issue_comment` / `pull_request` behavior before any tag exists — no circular dependency.

1. Move the reviewer into `heimdall`; point File Valet's caller at `@main` (or a pre-release SHA).
2. **Cutover (avoid dual-review):** in the **same PR** that adds File Valet's `ai-review.yml` caller,
   **delete the standalone `ai-pr-review.yml`** — otherwise both fire and post two reviews under two
   identities. This is a required step, not cleanup.
3. Dogfood on real File Valet PRs. Confirm: identity is `heim-dall[bot]`; token is minimal-scoped;
   inline anchors are correct; out-of-diff folding works; per-finding validation keeps good findings;
   total-parse fallback works (force it); §5 gates reject fork-head commands + non-writers; TOCTOU
   SHA-pin holds.
4. Cut `@v1.0.0`, set the moving `@v1` alias; repoint File Valet's caller to `@v1`; add callers to
   1–2 more repos.
5. Roll org-wide (per-repo caller, or an org ruleset later — with a documented per-repo opt-out, §11).

---

## 11. Out of scope (this spec)

- **Hermes token broker** — separate spec; shares only §3.
- **Per-push incremental reviews** (`synchronize`) — deliberately excluded.
- **Standalone webhook server** — unneeded while Actions catches events; revisit only on minutes/dedup
  pressure.
- **LEFT-side / deleted-line inline comments** — folded to summary in v1; revisit later.
- **Org-ruleset forced rollout** — later; when done, ship a per-repo opt-out (e.g. an
  `.ai-review/disabled` sentinel or path filter) so monorepos/vendored trees can bow out.

---

## 12. Blocking prerequisites (promoted from v1 "open questions")

These must be resolved **before** implementation starts — they are critical-path, not plan-time:

1. **Org-admin owner** to (a) register the App, (b) grant the union permissions, (c) set the two
   org-level secrets. Without this, nothing in §3 can happen.
2. **`heimdall` repo** created + its admin/owner named (who cuts tags, moves the `@v1` alias,
   controls the reusable workflow's visibility so other org repos can call it).

Non-blocking, decide during planning: final bot name (`heimdall` proposed; or extend an existing
App); whether the summary **Check Run** (§7.4) ships in `@v1` or later.
