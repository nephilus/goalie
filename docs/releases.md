# Release and first-publication checklist

This guide covers repository setup, reviewed releases, and immutable versioned image publication. Source is public and hosted CI has passed; releasing a version and publishing its images are separate steps.

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

The workflow opens or updates one release PR from Conventional Commit history. `always-update` keeps that PR based on current `main` even when a maintenance commit leaves release notes unchanged; it does not force maintenance commits to create releases. A maintainer reviews and squash-merges the PR. Release Please then creates the version tag and GitHub release; it does not auto-merge or deploy.

Use Conventional Commit PR titles: `fix:` means patch, `feat:` means minor, and `!` or a `BREAKING CHANGE:` trailer means major, including below 1.0. Preserve breaking trailers and the most significant change when squash-merging. Other maintenance types do not necessarily produce a release. The empty initial manifest and explicit `initial-version: 0.1.0` bootstrap the first Node release at 0.1.0; afterward Release Please owns versions, generated changelog entries, and tags.

## 4. Docker Hub

1. Sign in to Docker Hub.
2. Open **My Hub → Repositories → Create repository**.
3. Use the intended existing user/organization namespace and name `goalie`; set visibility to **Public**. If that name is already owned for this project, reuse it; otherwise choose the intended existing name and use the full namespace/repository in configuration.
4. Do not enable Docker Hub autobuilds; GitHub Actions owns builds.
5. Configure Docker Hub tag immutability for **all tags**. The publication workflow never overwrites or deletes an existing target.
6. In account settings, create a personal access token named `goalie-github-actions` with an owner-selected expiry and **Read** and **Write** only (no Delete). Store it directly in the GitHub Actions secret `DOCKERHUB_TOKEN`, never in chat or a file.
7. Add repository variables `DOCKERHUB_USERNAME` (login user) and `DOCKERHUB_IMAGE` (full lowercase namespace/repository). The publish preflight rejects URLs, shell-like arguments, and names that are not lowercase namespace/repository values.

## 5. GHCR

The publish job uses `GITHUB_TOKEN` and needs no additional PAT. On first push, GHCR packages default to private. Visit package settings, verify the repository link and Actions access, and explicitly change package visibility to **Public**. Repository visibility alone does not guarantee anonymous package pulls.

The GHCR application guard checks the remote target before every write, but it cannot provide atomic registry immutability against an external writer. Do not configure another publisher for these image names. If a different publisher races the guard, the resulting target is not considered safe.

## 6. CI, release, and image handoff

Pull requests run secret-free Node24.14/Bun1.4.2 source checks, disposable PostgreSQL tests with zero skips/cancellations, application build, and Helm validation. They explicitly defer authenticated image qualification. Trusted main pushes, weekly main runs, and validated release calls build one native linux/amd64 DHI image and require image smoke, fresh vulnerability scan and same-image kind/Helm acceptance. Missing DHI credentials or any failed gate blocks export. With `export-image=true`, the 7-day `goalie-image` artifact contains the tested tar, metadata, qualified chart, scan/SBOM evidence, qualification summary, BOM and checksums. Publication loads that tar without rebuilding. ARM is not qualified. The new authenticated pipeline must pass on a trusted runner before this candidate is released.

Provision separate read-only DHI credentials privately as Actions secrets
`DHI_USERNAME` and `DHI_TOKEN`; do not reuse Docker Hub publication credentials.
The reusable workflow declares these explicitly, and publication passes only those
two secrets. PR jobs receive neither. The trusted gate verifies source reachability
from main before privileged image work; arbitrary untrusted refs cannot export.
Registry authentication uses temporary isolated storage and is removed afterward.

Weekly `0 6 * * 1` runs requalify pinned main and separately rescan the latest
published stable GHCR version through the existing release validator. No published
stable release is an explicit no-rescan outcome; inability to access or scan an
existing release is a failure. Main scans do not identify deployed customer images.
Available scan reports upload even when a gate fails; failed candidates never export.

A normal release path is:

1. CI passes.
2. Release Please opens a release PR.
3. A maintainer reviews and squash-merges the release PR.
4. Release Please creates the strict `vMAJOR.MINOR.PATCH` tag and published GitHub release.
5. Publish resolves that tag, verifies its commit is reachable from `main` and package version matches, then calls CI on that exact commit with image export enabled.
6. The publish job verifies image ID, revision, version, and metadata before considering either registry target.
7. Before **any** write, the publication guard checks both registry targets and compares each existing image ID/config digest with the tested image. It skips identical targets and aborts all writes on a different image or an authentication, permission, rate-limit, or network-ambiguous failure. Only an explicit missing-manifest/name response permits publication. Checking both first prevents a rebuilt artifact from splitting one version across different images. The guard does not intentionally overwrite or delete existing tags; GHCR still requires the single-publisher constraint above.
8. Both registries receive only the tested image under their `X.Y.Z` version tag: `ghcr.io/<lowercased-owner>/<repo>:X.Y.Z` and `${DOCKERHUB_IMAGE}:X.Y.Z`. There is no `latest`, branch, or major/minor alias.
9. Verify anonymous pulls from both registries, matching version/revision labels, and the image smoke result before announcing availability.

Two-registry publication is nonatomic. If one registry succeeds and the other fails, the workflow reports which succeeded and does not delete or roll it back. Rerunning the failed job with the retained 7-day artifact is supported. After that artifact expires, recover the original image from a registry or other retained store, or use a new version. Rebuilding can produce a different image and may conflict with an existing immutable tag; it cannot overwrite that tag.

The container smoke alone checks migrations, readiness, unauthenticated API denial, login redirect, manifest/icon delivery, Bun runtime hardening and identity. Separate disposable Kubernetes acceptance exercises production PostgreSQL/OIDC TLS, probe behavior, migration-failure rollout blocking and key projection. Synthetic fixtures are not proof of actual GitLab/EDB integration. Interactive Bun/Dex authentication and manual work/cancellation qualification remain required runtime checks.

The checked-in preflight helper can be exercised with repository-read GitHub credentials:

```sh
GITHUB_TOKEN="$GITHUB_TOKEN" node scripts/release-preflight.mjs \
  --tag vMAJOR.MINOR.PATCH --repository owner/name --output preflight.json
```

It uses `GITHUB_API_URL` when provided (otherwise `https://api.github.com`) and rejects malformed tags before API calls. The output JSON contains `tag`, `version`, `commit`, and `mainCommit` after verifying a published non-draft/non-prerelease release, tag reachability from `main`, and exact `package.json` version at the tag. There is no offline or mock bypass; keep the output private until publication review.


## 7. Owner verification boundary

The earlier source CI and Release Please PR generation were exercised; that does not qualify the new DHI/Helm pipeline. Authenticated builds/scans and all image-dependent acceptance must pass before release. GitHub release/tag creation, registry publication, air-gap transfer and deployment require their own authorization. Repository protection and private vulnerability reporting are configured separately; passing CI does not prove those settings.

## 8. Air-gap delivery

Build and scan outside the air gap. After all image gates pass, package with:

```sh
CONTAINER_ENGINE=podman EXPECTED_REVISION=<qualified-source-sha> \
  node scripts/package-image.mjs <tested-image> <report-directory> <empty-bundle-directory>
```

The packager requires matching scan, container-smoke and Kubernetes success evidence,
including the hash of the exact installed chart. It verifies the final tar by loading
it into a second uniquely owned kind node and comparing image config identity.
It never rebuilds or pushes. `metadata.json` retains the publication identity contract;
`bom.json` and `SHA256SUMS` cover the image, chart and evidence.
No credentials, CA private keys, fixture images, Dex/PostgreSQL services or operators
belong in the bundle. Candidate artifacts are not public releases.

A local build containing uncommitted changes is not a build of its base commit,
even when that commit appears in the image's revision label. Keep such output
explicitly classified as an uncommitted local candidate in its provenance and
checksummed bill of materials; do not claim an exact source SHA or release readiness.
Commit/review the implementation and qualify that exact commit through trusted CI
before using the publication handoff.

Inside the approved transfer boundary, verify `sha256sum -c SHA256SUMS` before
`docker load --input goalie-image.tar` (or Podman equivalent). Compare the loaded
config ID to `metadata.json`. Only after separate approval of the exact internal
registry/repository may an operator tag/push the loaded image. Record the resulting
destination registry manifest digest; it is not the image config ID.
Install the supplied local chart with that internal repository/digest, existing
pull credentials and existing GitLab/CNPG Secrets. Do not run `helm dependency update`,
download packages, or give the cluster DHI credentials/public-registry dependencies.
Back up/review schema before installation; Helm rollback does not undo migrations.
