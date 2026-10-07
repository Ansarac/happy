# Installing this fork's happy CLI

This fork (`Ansarac/happy`) publishes its own build of the `happy` CLI on
GitHub Releases. `npm install -g happy` installs the **official** build from
npm, which lacks this fork's changes, and replaces the fork build without
asking. Avoid `npm update -g` too: it looks `happy` up on the npm registry,
where the official `1.2.5` sorts above a fork build such as
`1.2.5-ansarac.12`. Use the commands below to install and to upgrade.

Each push to `main` that touches the CLI builds a tarball, runs the unit
tests, installs it on Linux and Windows and checks that it runs, then
publishes it (`.github/workflows/cli-package.yml`):

| Release | Assets | Use |
|---|---|---|
| `cli-latest` | `happy-cli.tgz`, `happy-cli.tgz.sha256` | Always the newest build. Stable URL. |
| `cli-v<version>` | `happy-<version>.tgz`, `.sha256` | One per build, never changes. Pin or roll back. |

Versions are `<upstream base>-ansarac.<CI run number>`, for example
`1.2.5-ansarac.12`. Builds from source report
`<base>-ansarac.local.<git sha>` (plus `.dirty` with uncommitted changes).
`happy --version` prints the version as its first line. When you are logged
in it then continues like plain `happy`: it starts the daemon if needed (a
daemon of a different version is replaced) and opens a short session. To
check the version with no side effects, use `npm ls -g happy`.

Requirements: Node.js 20 or newer with npm. Building from source also needs
git; pnpm is optional (corepack is used if pnpm is missing).

## Install or upgrade

Same command on Linux, macOS and Windows (bash, zsh, PowerShell, cmd):

```bash
npm install -g https://github.com/Ansarac/happy/releases/download/cli-latest/happy-cli.tgz
```

The same command upgrades. If npm reports the previous version, it served a
cached copy: add `--prefer-online`.

A specific build, e.g. to roll back:

```bash
npm install -g https://github.com/Ansarac/happy/releases/download/cli-v1.2.5-ansarac.12/happy-1.2.5-ansarac.12.tgz
```

### With the installer script

`scripts/install-happy-cli.mjs` does the same and also:

- checks the tarball against the published `.sha256` before installing it,
- stops a running happy daemon first (npm cannot replace files a running
  daemon holds open on Windows), and tells you to start it again,
- prints the installed version and warns if another `happy` comes first on
  `PATH` (an old `npm link`, another Node install).

```bash
node scripts/install-happy-cli.mjs                      # latest
node scripts/install-happy-cli.mjs --version 1.2.5-ansarac.12
node scripts/install-happy-cli.mjs --dry-run            # show what it would do
```

It has no dependencies, so it can be run without cloning the repo: download
[`scripts/install-happy-cli.mjs`](https://raw.githubusercontent.com/Ansarac/happy/main/scripts/install-happy-cli.mjs)
and run it with `node`.

### From source

Builds the checked-out commit, packs it and installs the tarball. The
checkout is left unchanged (the version is stamped into
`packages/happy-cli/package.json` for the build and restored afterwards, also
on failure or Ctrl+C).

```bash
git clone https://github.com/Ansarac/happy && cd happy && node scripts/install-happy-cli.mjs --from-source
```

Upgrade with `git pull --ff-only` and the same command. `--skip-install`
skips `pnpm install` when dependencies are already current.

Install the packed tarball rather than `npm link`-ing the checkout: a pnpm
checkout can contain two copies of React, which crashes the CLI's terminal UI.
npm dedupes the tarball's dependencies.

### After installing: the daemon

The installer stops a running daemon. Start it again:

```bash
happy daemon start
```

If a service manager runs the daemon (a systemd user unit, launchd, a Windows
scheduled task), restart it there instead, e.g.
`systemctl --user restart happy-daemon`. Check that the unit's `ExecStart`
runs the `happy` you just installed (`npm prefix -g`), not an older one. Any
`happy` command whose version differs from the running daemon's replaces that
daemon with its own, outside the service manager, so a unit and a `happy` on
`PATH` at different versions keep displacing each other.

Without the installer: a running daemon notices the new version and restarts
itself on its next heartbeat, but on Windows npm may fail to replace files it
holds open. Run `happy daemon stop` before `npm install -g` there.

## Using a self-hosted server

The CLI reads the server from `serverUrl` in `~/.happy/settings.json`
(`%USERPROFILE%\.happy\settings.json` on Windows). `HAPPY_SERVER_URL`
overrides it. If your server also serves the web app, set `webappUrl` to the
same address.

1. Add the key to the existing file. Keep the other keys. The file must stay
   valid JSON: if it does not parse, the CLI silently uses the defaults
   (the official server) and later overwrites the file.

   ```json
   {
     "serverUrl": "https://happy.example.com"
   }
   ```

2. Log in again so the CLI creates credentials on that server:

   ```bash
   happy auth login --force
   ```

   `--force` clears the old credentials and machine ID and stops the daemon.

3. Check with `happy doctor` (prints `Server URL`), then `happy daemon start`.

## Behind a corporate proxy

npm uses its own proxy settings (`npm config get proxy`, `https-proxy`) or
the `HTTP(S)_PROXY` variables. The CLI and its daemon need the variables:

| Variable | Why |
|---|---|
| `HTTPS_PROXY`, `HTTP_PROXY` | Proxy for the CLI's API calls and its realtime (WebSocket) connection. |
| `NO_PROXY=localhost,127.0.0.1,::1` | The CLI talks to its daemon on 127.0.0.1. That must never go to the proxy. Add your self-hosted server if it is internal. |
| `NODE_USE_ENV_PROXY=1` | Node's built-in `fetch` ignores the proxy variables without this (Node >= 22.21 / 24). The installer script sets it for its own downloads. |
| `NODE_EXTRA_CA_CERTS=/path/to/corp-root.pem` | For TLS-inspecting proxies: Node does not use the OS certificate store. Without it requests fail with `unable to get local issuer certificate`. |

The daemon only sees variables that were set in the environment it was
started from. Set them in your shell profile (and in the unit's
`Environment=` for a systemd-managed daemon), then restart the daemon.

Linux / macOS (`~/.bashrc`, `~/.zshrc`):

```bash
export HTTPS_PROXY=http://proxy.example.com:3128
export HTTP_PROXY=$HTTPS_PROXY
export NO_PROXY=localhost,127.0.0.1,::1
export NODE_USE_ENV_PROXY=1
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt   # or your corporate root
```

## Windows

Everything above works on Windows with Node.js for Windows. Notes:

- npm puts `happy.cmd` (and `happy.ps1`) in `npm prefix -g`, usually
  `%APPDATA%\npm`, which the Node installer adds to `PATH`. If PowerShell
  refuses to run `happy.ps1` (execution policy), run `happy.cmd` or
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- The tarball carries Windows builds of its bundled tools (ripgrep,
  difftastic), and npm installs the Claude Agent SDK's Windows binary
  (`@anthropic-ai/claude-agent-sdk-win32-x64` or `-arm64`) as an optional
  dependency. Do not install with `--omit=optional`.
- Settings live in `%USERPROFILE%\.happy\settings.json` (`$HOME\.happy` in
  PowerShell). Save it as UTF-8 **without** a BOM. Windows PowerShell 5.1's
  `Set-Content -Encoding utf8` and `Out-File` write a BOM, the CLI cannot
  parse that, and silently falls back to the defaults. Notepad saves without
  BOM. In PowerShell:

  ```powershell
  $f = "$HOME\.happy\settings.json"
  $s = if (Test-Path $f) { Get-Content $f -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
  $s | Add-Member -Force -NotePropertyName serverUrl -NotePropertyValue 'https://happy.example.com'
  New-Item -ItemType Directory -Force (Split-Path $f) | Out-Null
  [IO.File]::WriteAllText($f, ($s | ConvertTo-Json -Depth 20))   # UTF-8, no BOM
  ```

- Proxy variables for the current PowerShell session:

  ```powershell
  $env:HTTPS_PROXY = 'http://proxy.example.com:3128'
  $env:HTTP_PROXY = $env:HTTPS_PROXY
  $env:NO_PROXY = 'localhost,127.0.0.1,::1'
  $env:NODE_USE_ENV_PROXY = '1'
  $env:NODE_EXTRA_CA_CERTS = 'C:\certs\corp-root.pem'   # PEM file, for TLS-inspecting proxies
  ```

  To keep them for new shells (and a daemon started from them), store them
  for your user, then open a new terminal:

  ```powershell
  foreach ($n in 'HTTPS_PROXY','HTTP_PROXY','NO_PROXY','NODE_USE_ENV_PROXY','NODE_EXTRA_CA_CERTS') {
    [Environment]::SetEnvironmentVariable($n, (Get-Item "env:$n").Value, 'User')
  }
  ```

  In cmd: `set HTTPS_PROXY=http://proxy.example.com:3128` for the session,
  `setx HTTPS_PROXY http://proxy.example.com:3128` to persist.

- `NODE_EXTRA_CA_CERTS` needs a PEM file. Export your corporate root CA from
  `certmgr.msc` (Trusted Root Certification Authorities, "Base-64 encoded
  X.509"), or ask IT for it.
- From source on Windows: same command in PowerShell (`cd happy; node
  scripts/install-happy-cli.mjs --from-source`). Needs Git for Windows.

## Uninstall or go back to the official build

```bash
npm uninstall -g happy        # remove
npm install -g happy          # official build from npm instead
```
