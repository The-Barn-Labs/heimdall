# Roadmap & known limitations

## Known limitations

- **Re-reviews stack in the PR timeline.** De-spam cleans up *content* — stale inline comments are
  minimized, the summary comment is updated in place — but the GitHub API has no way to delete or
  merge a review object (only APPROVED/CHANGES_REQUESTED reviews can be dismissed, never `COMMENT`,
  which this design always posts, and there's no delete endpoint for reviews at all). A PR re-reviewed
  several times will show several stacked "heim-dall reviewed N ago" entries in the timeline even
  though the visible comment content is fully de-duplicated. Platform limitation, not fixable here.
- **GitHub Free plan: org secrets don't reach private repos.** `HEIMDALL_APP_ID` /
  `HEIMDALL_PRIVATE_KEY` had to be set as **repo-level** secrets on each private consuming repo
  instead of once at the org level (File Valet's are set this way). Revisit if the org ever upgrades
  to GitHub Team/Enterprise Cloud — org-level secrets would then reach private repos too.
- **Fork-PR and unauthorized-actor paths are unit-tested, not live-dogfooded.** `gate.mjs`'s
  fork-blocking and write-access-check logic has dedicated tests (Task 3), but there's been no live
  test against an actual fork PR or a genuinely unauthorized commenter — the org has no forks and is
  effectively single-admin today. Revisit if either changes.
- **`review deep` has no spend cap.** It's gated to write/admin access, but not rate-limited —
  an authorized actor can invoke it repeatedly with no per-day/per-actor budget.

## Planned / candidate future work

1. **Hermes token broker.** Same App (union-permissioned for exactly this), mints scoped installation
   tokens for Hermes agents. Separate design — shares only the App registration with the reviewer.
2. **Roll out to more org repos** beyond File Valet.
3. **Org-wide required-workflow ruleset**, once adopted broadly enough to justify it — needs a
   documented per-repo opt-out (e.g. a sentinel file or path filter) before going org-wide-mandatory.
4. **Rate-limit `review deep`** — count the bot's prior "deep" comments in the last 24h and downgrade
   to the default model tier if exceeded. Deferred at v1 (see the design spec's §8 note); the
   write/admin auth gate was judged sufficient for now.
5. **Optional Check Run summary** instead of a PR issue comment — cleaner conversation view, and
   annotations auto-clear on new commits. Deferred at v1 (design spec §7.4).
6. **A lightweight smoke-test harness for the workflow YAML itself.** Several of v1's real bugs
   (cross-repo caller-permissions requirement, `workflow_call` ref-resolution gap, the concurrency
   self-cancel race) were invisible to `actionlint` and only surfaced via live dispatch against a real
   repo. A scripted smoke test — a disposable throwaway caller + a trivial reusable workflow, driven
   via `gh workflow run` + poll — could catch a regression before it reaches a real PR.

## Where design work happens

Future improvements to heimdall are designed and planned **in this repo**, not in the org's
`dev-playbook` (the portable knowledge base). Use `docs/superpowers/specs/` and
`docs/superpowers/plans/` here for any new design/planning work — see
[`docs/superpowers/specs/2026-07-02-org-ai-reviewer-github-app-design.md`](docs/superpowers/specs/2026-07-02-org-ai-reviewer-github-app-design.md)
and
[`docs/superpowers/plans/2026-07-03-org-ai-reviewer-inline-comments.md`](docs/superpowers/plans/2026-07-03-org-ai-reviewer-inline-comments.md)
for the v1 build's own design history (including the adversarial security review that shaped it).

Once a change is proven here — dogfooded on a real org PR — it can be *harvested* into
`dev-playbook`'s [`assets/ci/ai-review/`](https://github.com/The-Barn-Labs/dev-playbook/tree/main/assets/ci/ai-review)
as a genericized, portable update for other orgs/repos to adopt. The working design docs stay local
to heimdall; only the proven, genericized result gets promoted outward.
