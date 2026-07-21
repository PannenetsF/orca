# Headless Linux Server

Use this guide when you want to run `orca serve` on a Linux machine without a
desktop session, such as an Ubuntu VPS or a remote build box.

`orca serve` starts the Orca runtime without opening the desktop window. On
Linux, the packaged AppImage still needs the libraries that Electron expects at
startup. Current Orca builds can start Xvfb automatically for `orca serve` when
no `DISPLAY` is set, but Xvfb must be installed first. When `DISPLAY` is set,
Orca uses that display instead of starting a competing Xvfb process.

## Ubuntu 22.04 Prerequisites

Install the AppImage runtime dependency and Xvfb:

```bash
sudo apt-get update
sudo apt-get install -y curl libfuse2 xvfb
```

Download and make the AppImage executable:

```bash
sudo mkdir -p /opt/orca
sudo curl -L https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage \
  -o /opt/orca/orca-linux.AppImage
sudo chmod +x /opt/orca/orca-linux.AppImage
```

If `Xvfb` was installed somewhere other than `/usr/bin`, confirm systemd can
find it later:

```bash
command -v Xvfb
```

## Run In The Foreground

Start with a foreground run before creating a service:

```bash
LIBGL_ALWAYS_SOFTWARE=1 /opt/orca/orca-linux.AppImage serve --port 6768
```

For remote clients, pass the address they should use to reach this server. A
Tailscale address is usually the safest option for private servers:

```bash
LIBGL_ALWAYS_SOFTWARE=1 /opt/orca/orca-linux.AppImage serve \
  --port 6768 \
  --pairing-address 100.64.1.20
```

The command prints the runtime endpoint and pairing URL. Stop it with `Ctrl+C`.

## Systemd Service

Create a dedicated service user and install directory. Run the service as this
user instead of root so the AppImage can keep Chromium's sandbox enabled.

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin orca
sudo chown -R orca:orca /opt/orca
```

For most hosts, one `orca serve` service is enough because Orca starts Xvfb on
display `:99` when no display exists:

```ini
# /etc/systemd/system/orca-serve.service
[Unit]
Description=Orca runtime server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=orca
WorkingDirectory=/home/orca
Environment=LIBGL_ALWAYS_SOFTWARE=1
ExecStart=/opt/orca/orca-linux.AppImage serve --port 6768 --pairing-address 100.64.1.20
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Replace `100.64.1.20` with the LAN, Tailscale, tunnel, or public hostname that
clients should use.

Enable the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now orca-serve.service
sudo journalctl -u orca-serve.service -f
```

## Managed Xvfb Service

If you prefer to own the virtual display lifecycle in systemd, run Xvfb as a
separate service and set `DISPLAY=:99` for Orca.

```ini
# /etc/systemd/system/orca-xvfb.service
[Unit]
Description=Virtual X display for Orca
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

If `command -v Xvfb` returned a different path, update `ExecStart` to that
absolute path.

Then add the display dependency to the Orca service:

```ini
# /etc/systemd/system/orca-serve.service
[Unit]
Description=Orca runtime server
After=network-online.target orca-xvfb.service
Wants=network-online.target orca-xvfb.service

[Service]
Type=simple
User=orca
WorkingDirectory=/home/orca
Environment=DISPLAY=:99
Environment=LIBGL_ALWAYS_SOFTWARE=1
ExecStart=/opt/orca/orca-linux.AppImage serve --port 6768 --pairing-address 100.64.1.20
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable both units:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now orca-xvfb.service orca-serve.service
```

## CLI Install Note

On a headless host, you do not need to open the desktop UI just to run the
server. Invoke the AppImage directly:

```bash
/opt/orca/orca-linux.AppImage serve --help
```

If you later install the desktop CLI from Orca settings, use that CLI for normal
shell workflows. Keep the AppImage path in systemd so service restarts do not
depend on an interactive shell profile.

## Upgrade

`orca serve` never updates itself. In headless mode Orca wires up no auto-updater
at all — the built-in updater only runs in the desktop GUI, and no paired mobile
or web client can trigger it remotely. Upgrading is always a deliberate step:
replace the AppImage and restart the service.

Two facts make this safe and predictable:

- **State lives in the service user's home, not next to the binary.** Persisted
  data is under `/home/orca/.config/` (Orca uses both an `orca` and an `Orca`
  directory there), fully independent of `/opt/orca/orca-linux.AppImage`.
  Replacing the binary never touches projects, worktree metadata, terminal
  history, orchestration state, or paired-device keys — so mobile and web
  clients reconnect after an upgrade without re-pairing.
- **New builds migrate old state on load.** `orca-data.json` is upgraded in place
  by idempotent, field-level migrations when the new version starts, so a forward
  upgrade needs no manual data step.

Rolling back is the case that needs care — see [Roll back](#roll-back).

### Record the version you deploy

Orca has no headless version command: there is no `--version` flag or `version`
subcommand, and `orca serve` prints only its endpoint. Track the version by the
release tag you install, and record it next to the binary so upgrades are
auditable:

```bash
echo "v1.4.147" | sudo tee /opt/orca/VERSION
```

### Upgrade steps

Never download straight onto `/opt/orca/orca-linux.AppImage`. The AppImage is
FUSE-mounted, so overwriting it in place while the service runs can crash or
corrupt the live process — and even with the service stopped, a failed or partial
download would clobber the working binary. Instead download to a temporary name
on the same filesystem, verify it, then swap it in with an atomic rename.

```bash
# Pin the release tag you are deploying. It drives both the download URL and the
# recorded VERSION, so the audit file always matches the installed binary.
TAG="v1.4.147"

# Run the whole procedure fail-fast so a failed step never promotes a bad binary.
set -euo pipefail

# 1. Stop the server so the state backup is consistent
sudo systemctl stop orca-serve.service

# 2. Back up the profile and keep the old binary + version for rollback
sudo tar czf /opt/orca/orca-backup-$(date +%F-%H%M%S).tgz -C /home/orca .config
sudo cp -a /opt/orca/orca-linux.AppImage /opt/orca/orca-linux.AppImage.prev
if [ -f /opt/orca/VERSION ]; then sudo cp -a /opt/orca/VERSION /opt/orca/VERSION.prev; fi

# 3. Download the new build next to the current one (same filesystem)
sudo rm -f /opt/orca/orca-linux.AppImage.new
sudo curl -fL --retry 3 https://github.com/stablyai/orca/releases/download/$TAG/orca-linux.AppImage \
  -o /opt/orca/orca-linux.AppImage.new
sudo chmod +x /opt/orca/orca-linux.AppImage.new
sudo chown orca:orca /opt/orca/orca-linux.AppImage.new

# Fail closed unless the download is a real ELF executable (not an HTML error page
# or a partial/empty file). The bad file is removed so a later run can't promote it.
if ! sudo file /opt/orca/orca-linux.AppImage.new | grep -q 'ELF'; then
  sudo rm -f /opt/orca/orca-linux.AppImage.new
  echo "Downloaded file is not an ELF executable — aborting upgrade" >&2
  exit 1
fi

# 4. Atomically replace the binary, record the version, then start
sudo mv -f /opt/orca/orca-linux.AppImage.new /opt/orca/orca-linux.AppImage
echo "$TAG" | sudo tee /opt/orca/VERSION
sudo systemctl start orca-serve.service
```

Backing up the whole `.config` directory (step 2) captures both the `orca` and
`Orca` directories in one archive, so you do not have to reason about which files
live where. If you run the managed Xvfb unit, only `orca-serve.service` needs
restarting — leave `orca-xvfb.service` running.

`$TAG` must be a published release tag (for example `v1.4.147`). Pinning a tag
instead of `latest` is what keeps `/opt/orca/VERSION` accurate and the upgrade
reproducible; browse available tags on the
[releases page](https://github.com/stablyai/orca/releases). To deploy the newest
release, set `TAG` to its tag rather than downloading `latest`.

### Verify

```bash
sudo journalctl -u orca-serve.service -f
```

A healthy start prints `Orca server ready: ws://0.0.0.0:6768` (with your port).
Confirm a client reconnects before you discard the backup.

### Roll back

A rollback is **not** binary-only safe. Once a newer build has started, it
rewrites `orca-data.json` in place, and an older build silently drops the newer
fields it does not recognize (workspace, terminal, and browser session layout in
particular). The rolling `orca-data.json.bak.*` files are corruption-recovery
snapshots, not a pre-upgrade copy — the new version overwrites them within hours.
So to roll back cleanly, restore the backup from step 2 **and** swap the binary
back:

```bash
sudo systemctl stop orca-serve.service
# Find the most recent pre-upgrade backup
ls -t /opt/orca/orca-backup-*.tgz | head -1
# Move the current (post-upgrade) profile aside instead of deleting it
sudo mv /home/orca/.config /home/orca/.config.rollback-$(date +%F-%H%M%S)
# Restore the backup listed above in place of <stamp>
sudo tar xzf /opt/orca/orca-backup-<stamp>.tgz -C /home/orca
sudo chown -R orca:orca /home/orca/.config
sudo mv -f /opt/orca/orca-linux.AppImage.prev /opt/orca/orca-linux.AppImage
# Restore the recorded version so /opt/orca/VERSION matches the restored binary
if [ -f /opt/orca/VERSION.prev ]; then sudo mv -f /opt/orca/VERSION.prev /opt/orca/VERSION; fi
sudo systemctl start orca-serve.service
```

Replace `<stamp>` with the timestamp of the archive you created. Restoring the
backup is required, not optional: swapping only the binary leaves the migrated
`orca-data.json` in place, so session and workspace state stays broken. Keep the
pre-upgrade backup until the new version is proven on your host.

## Troubleshooting

- `dlopen(): error loading libfuse.so.2`: install `libfuse2`.
- `Missing X server or $DISPLAY`: install `xvfb`, or start the managed Xvfb
  service and set `DISPLAY=:99`.
- `Xvfb not found`: confirm `command -v Xvfb` and use that absolute path in the
  systemd unit.
- GPU or DRI warnings on a VPS: keep `LIBGL_ALWAYS_SOFTWARE=1` in the service
  environment.
- Chromium sandbox errors: confirm the service is running as the non-root
  `orca` user and that `/opt/orca` is readable by that user.
- Clients cannot connect: make sure `--pairing-address` is an address reachable
  from the client, and make sure firewalls allow the selected `--port`.
- Service crash-loops right after an upgrade: the promoted binary is likely a bad
  build. Do **not** re-run Upgrade first — it won't restore the pre-upgrade
  `orca-data.json` the new build already migrated. Stop the service and
  [Roll back](#roll-back) to the known-good binary and its matching config backup,
  then retry the upgrade with a verified `TAG`.
- Diagnosing other missing libraries: extract the AppImage without launching it
  with `./orca-linux.AppImage --appimage-extract`, then run
  `ldd squashfs-root/orca` to list any shared libraries the host is missing.
