# heimdall

Shared, versioned CI for the org. Currently: the AI PR reviewer.

## Consuming the reviewer
Add `.github/workflows/ai-review.yml` to your repo (see the playbook asset) and pin `@v1`.

## Releasing
Edit `.github/workflows/ai-pr-review.yml` or `scripts/*.mjs`, then:
`git tag v1.2.3 && git push origin v1.2.3 && git tag -f v1 v1.2.3 && git push -f origin v1`
Callers pinned to `@v1` pick it up. Breaking changes: cut `v2`, migrate callers deliberately.
