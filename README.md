# heimdall

Shared, versioned CI for The-Barn-Labs org. Currently: an App-identity AI PR reviewer
(`heim-dall[bot]`) that posts line-anchored inline review comments. Live at `v1`, adopted by
File Valet.

See [ROADMAP.md](ROADMAP.md) for known limitations and planned future work (Hermes token broker,
more repos, `review deep` rate limiting, etc.).

## Consuming the reviewer

Add a thin caller to your repo as `.github/workflows/ai-review.yml`:

```yaml
name: AI Review
on:
  pull_request:
    types: [opened, ready_for_review, reopened]
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      pr_number: { description: 'PR number', required: true, type: string }

concurrency:
  group: ai-review-${{ github.event.pull_request.number || github.event.issue.number || inputs.pr_number }}
  cancel-in-progress: ${{ github.event_name != 'issue_comment' || (contains(github.event.comment.body, '@heim-dall') && github.actor != 'heim-dall[bot]') }}

permissions:
  contents: read
  pull-requests: read

jobs:
  review:
    if: ${{ (github.event_name != 'issue_comment' || contains(github.event.comment.body, '@heim-dall')) && github.event.pull_request.draft != true && github.actor != 'dependabot[bot]' && github.actor != 'heim-dall[bot]' }}
    uses: The-Barn-Labs/heimdall/.github/workflows/ai-pr-review.yml@v1
    secrets:
      HEIMDALL_APP_ID: ${{ secrets.HEIMDALL_APP_ID }}
      HEIMDALL_PRIVATE_KEY: ${{ secrets.HEIMDALL_PRIVATE_KEY }}
      OPENCODE_GO_KEY: ${{ secrets.OPENCODE_GO_KEY }}
    with:
      pr_number: ${{ inputs.pr_number }}
```

- **Secrets:** `HEIMDALL_APP_ID` / `HEIMDALL_PRIVATE_KEY` (the org's `heim-dall` GitHub App) and
  `OPENCODE_GO_KEY` must be visible to the consuming repo. On GitHub Free, org-level secrets only
  reach *public* repos — for a private repo, set these as **repo-level** secrets instead (no code
  change needed either way; `secrets:` mappings resolve repo-level secrets the same way).
- **Permissions block is not optional.** If the caller omits it, GitHub rejects the cross-repo
  `workflow_call` outright — `startup_failure`, zero jobs, no diagnostic.
- **Commands:** `@heim-dall review` (default), `@heim-dall review deep` (forces the escalated model
  tier), `@heim-dall explain <topic>`.

## Releasing

Edit `.github/workflows/ai-pr-review.yml` or `scripts/*.mjs`, then:

```bash
git tag v1.2.3 && git push origin v1.2.3
git tag -f v1 v1.2.3 && git push -f origin v1
```

Callers pinned to `@v1` pick it up automatically. Breaking changes: cut `v2`; callers migrate
deliberately by changing their own `@v1` → `@v2`.

> ⚠️ **Re-tag `v1` immediately after every commit that touches `scripts/*.mjs` or the workflow
> itself — even mid-debugging a live issue.** The self-checkout of this repo's own scripts
> (`ref: main` in `ai-pr-review.yml`) intentionally tracks `main`, not `v1` — that's what lets you
> dogfood a fix via a caller pinned to `@main` before cutting a release. But it means `main` and
> `v1` can silently drift apart: a caller pinned to `@v1` runs whatever workflow YAML `v1` resolved
> to, while `main`'s self-checkout step (baked into that same YAML) always fetches the *current*
> `main` scripts — if a later commit to `main` changes their behavior before `v1` is re-tagged,
> `@v1` callers get an inconsistent pairing of old YAML + newer scripts. Found the hard way: several
> commits landed on `main` here while chasing live bugs before `v1` was re-tagged, so verification
> runs against `@v1` were silently testing stale code. Treat "re-tag v1" as part of the fix, not a
> separate follow-up step.

## Design docs

Design and planning for heimdall live **in this repo**, not in the org's `dev-playbook` — see
`docs/superpowers/specs/` and `docs/superpowers/plans/`, and [ROADMAP.md](ROADMAP.md) for what's
next. Proven changes get harvested outward into `dev-playbook`'s `assets/ci/ai-review/` as a
genericized, portable update once dogfooded here.
