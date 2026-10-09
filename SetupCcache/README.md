# Setup ccache

Sets up ccache for a C/C++ build job. This implements Proposal 2 of the CI spend RFC: one shared
ccache store per kind of runner, which every branch reads and writes, instead of the GitHub Actions
cache. Mid-stack PRs then reuse objects built by the PRs below them, and the Actions cache quota
stops mattering.

| Runner | Store | How the job reaches it |
| --- | --- | --- |
| Self-hosted (`ubuntu-iar`) | Stafl-EMB03 on the office LAN (`LAN_CCACHE_URL`) | Plain HTTP with basic auth; the server's firewall only lets Stafl-EMB02 in |
| GitHub-hosted | `ccache1.ci.emb.staflsystems.com` on AWS (`AWS_CCACHE_URL`) | A ghostunnel client on `localhost:8080`, which forwards over TLS. ccache's HTTP backend can't speak HTTPS |

The two kinds of runner build with different images and compilers, so they never share an object
and splitting the store costs no hits. Server setup: [CI Servers](https://staflsystems.atlassian.net/wiki/spaces/EM/pages/193363969/CI+Servers)
(LAN) and [Embedded AWS Ccache](https://staflsystems.atlassian.net/wiki/spaces/EM/pages/2279080022/Embedded+AWS+Ccache).

## Modes

`mode` is usually the repository variable `CCACHE_MODE`, so switching a repo needs no PR, and
switching back is the rollback.

- **`actions`** (default): today's behavior. ccache caches in the GitHub Actions cache through
  `hendrikmuhs/ccache-action`, under `key`.
- **`remote`**: ccache uses the shared store for this runner, and the Actions cache isn't touched.
  The job zeroes ccache's stats at the start and prints `ccache -s` at the end, which
  `CIMetrics --ccache` reads.

`write-only: 'true'` compiles every file and writes the result, without reading the store
(ccache's `recache`). Set it on pushes to main: only main tags releases, so tagged binaries never
reuse an object a PR wrote, and main still seeds the store for the next PRs. In `actions` mode it
skips the restore, as the BMS2000 repos' `restore: ${{ github.ref != 'refs/heads/main' }}` does today.

If the store can't be reached, the job warns and builds without it. ccache also treats a store
error during the build as a miss, so an outage only makes builds slower.

## Usage

```yaml
    steps:
      - uses: actions/checkout@v4

      - uses: StaflSystems/CustomGithubActions/SetupCcache@main
        with:
          mode: ${{ vars.CCACHE_MODE || 'actions' }}
          key: ${{ github.job }}-${{ matrix.build-preset }}
          write-only: ${{ github.ref == 'refs/heads/main' }}
          fork: ${{ endsWith(matrix.configure-preset, '-iar') }}
          aws-url: ${{ vars.AWS_CCACHE_URL }}
          aws-password: ${{ secrets.AWS_CCACHE_HTTP_PASSWORD }}
          lan-url: ${{ vars.LAN_CCACHE_URL }}
          lan-password: ${{ secrets.LAN_CCACHE_HTTP_PASSWORD }}

      - run: cmake --preset ${{ matrix.configure-preset }} -DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache
```

It replaces both the copied "setup ccache" step that downloads the IAR-capable fork (`fork: 'true'`)
and the `hendrikmuhs/ccache-action` step. It sets `CCACHE_CONFIGPATH` to `ccache_config.conf` in
the workspace when that file exists. Set `max_size` there only for `actions` mode; the shared stores
have their own limits.

## ccache versions

The jobs run three versions today: Ubuntu's 4.5.1 in the CI image, 4.9 in newer images, and the
IAR-capable fork (4.12). So the store is set with environment variables that all of them accept:

- `CCACHE_SECONDARY_STORAGE`: the setting's name before 4.7, which renamed it `remote_storage`.
  4.7 and later still accept the old name.
- `CCACHE_REMOTE_ONLY=1`: skips the local cache, which starts empty in every job anyway. It needs
  4.7; older versions ignore unknown `CCACHE_*` variables. Don't put `remote_only` in
  `ccache_config.conf`: ccache stops with an error on a config file setting it doesn't know.

## Testing

`.github/workflows/setup-ccache-smoke.yml` runs on every PR that changes this action, and by hand.
For each store and ccache version, it builds 20 files three times: the first build must miss and
write to the store, the second must hit in the store after the local cache is cleared, and a third,
with the store unreachable, must still pass.
