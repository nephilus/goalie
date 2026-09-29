# Release and first-publication checklist

This repository preparation does not create a GitHub repository, publish source, log in to a registry, or claim a hosted release. An owner must complete the following steps deliberately.

## 1. Audit before publication

- Build the actual public candidate from the intended roots and review every filename and diff.
- Scan the candidate with upstream Gitleaks and review private-marker searches for credentials, private hosts/paths, deployment receipts, local tool configuration, and populated environment files.
- If a Git history exists, scan tracked files and all refs as a separate gate. `.gitignore` does not remove already committed material.
- Privately revoke/rotate any confirmed exposed credential before pushing. Keep private incident reports, backups, runtime state, and local receipts out of the public tree and image context.

## 2. Create and configure GitHub

When ready, create the public repository with default branch `main`, enable Actions, and enable private vulnerability reporting. If repository policy requires it, allow GitHub Actions to create pull requests. Configure squash merges with PR titles in Conventional Commit format and require the actual CI check after its first run. Local files do not prove these settings are configured.

Initialize Git only after the candidate audit, stage only reviewed public files, inspect staged filenames/diff, and create a Conventional Commit such as:

```text
feat: introduce Goalie workstream planning
```

Add the owner-selected remote and push only after separate authorization. Never use `git add .` without reviewing ignored and untracked boundaries. Do not push `.local`, `.env`, `.omp`, `.impeccable`, backups, or private agent state.

## 3. Release Please token

Add a fine-grained, repository-scoped Actions secret named `RELEASE_PLEASE_TOKEN`. Grant only Contents, Pull requests, and Issues read/write for this repository, with an owner-selected expiry. This is separate from `GITHUB_TOKEN` and from the Docker Hub token. The release workflow fails clearly when the secret is absent; it does not fall back to `GITHUB_TOKEN`.

The workflow opens or updates one release PR from Conventional Commit history. A maintainer reviews and squash-merges it. Release Please then creates the version tag and GitHub release; it does not auto-merge or deploy.

Use Conventional Commit PR titles: `fix:` means patch, `feat:` means minor, and `!` or a `BREAKING CHANGE:` trailer means major, including below 1.0. Preserve breaking trailers and the most significant change when squash-merging. Other maintenance types do not necessarily produce a release. The empty initial manifest and explicit `initial-version: 0.1.0` bootstrap the first Node release at 0.1.0; afterward Release Please owns versions, generated changelog entries, and tags.

## 4. Docker Hub

1. Sign in to Docker Hub.
2. Open **My Hub → Repositories → Create repository**.
3. Use the intended existing user/organization namespace and name `goalie`; set visibility to **Public**. If that name is already owned for this project, reuse it; otherwise choose the intended existing name and use the full namespace/repository in configuration.
4. Do not enable Docker Hub autobuilds; GitHub Actions owns builds.
5. In account settings, create a personal access token named `goalie-github-actions` with an owner-selected expiry and **Read** and **Write** only (no Delete). Store it directly in the GitHub Actions secret `DOCKERHUB_TOKEN`, never in chat or a file.
6. Add repository variables `DOCKERHUB_USERNAME` (login user) and `DOCKERHUB_IMAGE` (full lowercase namespace/repository). The publish preflight rejects URLs, shell-like arguments, and names that are not lowercase namespace/repository values.

## 5. GHCR

The publish job uses `GITHUB_TOKEN` and needs no additional PAT. On first push, GHCR packages default to private. Visit package settings, verify the repository link and Actions access, and explicitly change package visibility to **Public**. Repository visibility alone does not guarantee anonymous package pulls.

## 6. CI, release, and image handoff

The reusable CI workflow runs on pull requests and pushes to `main`, and can be called for an exact release commit. It runs Node 24.14.0, Bun 1.4.2, disposable PostgreSQL, typecheck, TAP tests, a build, and native linux/amd64 image acceptance. With `export-image=true`, it also uploads the retained `goalie-image` artifact containing that tested image tar and metadata. The publish workflow downloads that artifact; it does not rebuild between smoke and push. ARM images are not published.

A normal release path is:

1. CI passes.
2. Release Please opens a release PR.
3. A maintainer reviews and squash-merges the release PR.
4. Release Please creates the strict `vMAJOR.MINOR.PATCH` tag and published GitHub release.
5. Publish resolves that tag, verifies its commit is reachable from `main` and package version matches, then calls CI on that exact commit with image export enabled.
6. The publish job verifies image ID, revision, version, and metadata before tagging the same image as `ghcr.io/<lowercased-owner>/<repo>:X.Y.Z` and `${DOCKERHUB_IMAGE}:X.Y.Z`.
7. `latest` is added only when the release is GitHub's current latest stable release. Major/minor aliases and branch images are never published.
8. Verify anonymous pulls from both registries, matching version/revision labels, and the image smoke result before announcing availability.

Two-registry publication is nonatomic. If one registry succeeds and the other fails, the workflow reports which succeeded and does not delete or roll it back. A retained artifact can be used to rerun the failed job. If it expired, dispatch the workflow again with the same validated tag after CI recreates a new tested artifact.

The smoke harness does not prove production TLS or OIDC login. It checks migrations, readiness, unauthenticated API denial, login redirect, manifest/icon delivery, runtime hardening, and image labels only.

The checked-in preflight helper can be exercised with repository-read GitHub credentials:

```sh
GITHUB_TOKEN="$GITHUB_TOKEN" node scripts/release-preflight.mjs \
  --tag vMAJOR.MINOR.PATCH --repository owner/name --output preflight.json
```

It uses `GITHUB_API_URL` when provided (otherwise `https://api.github.com`) and rejects malformed tags before API calls. The output JSON contains `tag`, `version`, `commit`, `mainCommit`, and `latestStable` after verifying a published non-draft/non-prerelease release, tag reachability from `main`, and exact `package.json` version at the tag. There is no offline or mock bypass; keep the output private until publication review.


## 7. Owner verification boundary

Hosted Actions, GitHub release/tag creation, GHCR/Docker Hub pushes, anonymous pulls, and repository settings remain unexercised until the owner completes setup and gives publication authorization. Do not describe local workflow files as a successful hosted release.
