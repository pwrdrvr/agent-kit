---
name: release
description: Release one or all public agent-kit packages to npm through the repository's Changesets and GitHub Actions workflow.
---

# Release agent-kit

Follow the [release workflow](../../../.github/workflows/release.yml) and
[Changesets configuration](../../../.changeset/config.json). Publishing uses
npm OIDC with provenance through the `npm-publish` environment, not local tokens.

## Prepare

Fetch `origin/main`; confirm the requested changes are merged and CI passes.
From that revision, run `pnpm changeset status --output=/tmp/agent-kit-release-plan.json`
and retain **every package name and new version** for verification. For all
pending releases, use the entire plan, including dependent-package bumps.
Discover public packages from `packages/*/package.json`; do not hardcode one
package or bump unchanged packages just to synchronize versions. If requested
changes lack a changeset, add appropriate bumps through the normal PR flow first.

## Version, then publish

Release currently has **only `workflow_dispatch`**: feature/version PR merges
do not start it automatically, despite the README's wording. Reuse an existing
`changeset-release/main` PR or active release run instead of duplicating it.

1. Dispatch `gh workflow run release.yml --repo pwrdrvr/agent-kit --ref main`.
   With pending changesets, it creates/updates the **Version Packages** PR.
2. Handle the run's `npm-publish` gate. Read pending approvals with
   `gh api repos/pwrdrvr/agent-kit/actions/runs/<run-id>/pending_deployments`.
   For an authorized release, if `current_user_can_approve` is true, POST to
   that endpoint with the returned environment ID:
   `-F 'environment_ids[]=<id>' -f state=approved -f 'comment=<release reason>'`.
   Otherwise report the approval blocker and run URL; do not weaken the gate.
3. Inspect the version PR against the plan and wait for CI. Bot PRs may need
   `gh api --method POST repos/pwrdrvr/agent-kit/actions/runs/<ci-run-id>/approve`.
   Once checks pass, merge the reviewed head SHA as part of the requested release.
4. Dispatch Release on `main` **again** and handle its environment gate.
   With changesets consumed, `pnpm release` builds and publishes **all unpublished
   public workspace versions**, then creates tags/releases. Check that set
   against the requested scope; do not substitute a single-package publish.

Prefer PwrAgent tools for PRs, CI reads, and merges when available; use `gh`
for dispatch and approvals. On failure, inspect logs and registry state before
retrying: some packages may already be published. Report missing bootstrap or
trusted-publisher setup rather than bypassing OIDC or repeatedly rerunning.

## Verify

For **each planned package/version**, check npm metadata, the intended tag
(normally `latest`), and provenance:

```sh
npm view <package>@<version> version dist-tags dist.integrity dist.attestations --min-release-age=0 --prefer-online --json --registry=https://registry.npmjs.org
```

The command-local age exception permits checking the requested fresh release;
leave global supply-chain settings unchanged. Registry visibility can lag a
successful workflow: recheck for up to five minutes, then report missing versions
instead of blindly republishing. When useful, smoke-test the published artifact
in a disposable install with scripts disabled. Report versions and release links,
distinguishing any incomplete packages.
