
# general notes about opto-sync and it's dependants and dependencies

keep in mind that opto-sync is a zed package (github.com/zed-pkg), so it's effectively an sdk or library used by other codebases.

so when making changes to opto-sync repos we must keep in mind consumers of the lib.
it's ok to make breaking changes, but make sure the versioning is good -

big breaking changes should have a semver major version bump, small breaking changes a minor bumb, no breaking changes or minute changes a patch etc etc.

here are a list of other repos that depend on opto-sync, these repos primarily wrap opto-sync and serve their respective gh org:

github.com/3fa-app/3fa-app-sync
github.com/athlet-o/athleto-sync
github.com/quaestor-ledger/quaestor-sync
github.com/sonus-auris/sonus-auris-sync
github.com/daedalus-fab/daedalus-sync
github.com/fiducia-cloud/fiducia-sync
github.com/zed-pkg/zed-sync (a bit meta since zed is package manager for opto-sync etc, so this one is very important to keep in mind)

## Repository-local Git worktrees

- Create or use a Git worktree only when the human operator explicitly authorizes it for the current task. Concurrency or a dirty checkout is not permission by itself.
- Put every authorized worktree at `<repository-root>/tmp/worktrees/<name>`; from the repository root, use `./tmp/worktrees/<name>`. Never place worktrees beside repositories or organization directories.
- Keep `tmp`, `temp`, `tmp/worktrees`, and `temp/worktrees` ignored in the repository-root `.gitignore`. Do not commit files from those directories.
- Relocate or remove a worktree only when the operator explicitly requests it. Before removal, preserve and publish intended changes, verify its commit is represented on the target branch, and confirm there are no tracked, untracked, ignored-sensitive, or in-use files that must survive. Remove it with `git worktree remove <path>` without `--force`; never delete a worktree directory with `rm`.
