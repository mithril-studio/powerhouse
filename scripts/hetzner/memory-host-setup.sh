#!/usr/bin/env bash
# Provision the shared agent memory on the Hetzner host. Idempotent; run as
# root over ssh:  ssh -i ~/.ssh/hetzner root@46.224.40.20 'bash -s' < scripts/hetzner/memory-host-setup.sh
# Then apply scripts/hetzner/Caddyfile (with the token filled in) and reload caddy.
set -euo pipefail

id memory >/dev/null 2>&1 || useradd -m -s /bin/bash memory

# Laptop key so `git push memory@host:memory.git` works.
install -d -m 700 -o memory -g memory /home/memory/.ssh
if [ -n "${LAPTOP_PUBKEY:-}" ]; then
  echo "$LAPTOP_PUBKEY" > /home/memory/.ssh/authorized_keys
  chmod 600 /home/memory/.ssh/authorized_keys; chown memory:memory /home/memory/.ssh/authorized_keys
fi

sudo -u memory -H bash -lc '
  set -e; cd ~
  [ -x ~/.local/bin/uv ] || curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
  ~/.local/bin/uv tool list 2>/dev/null | grep -q basic-memory || ~/.local/bin/uv tool install basic-memory >/dev/null
  git config --global user.name memory-host
  git config --global user.email memory@factory.mithril-studio.com
  [ -d ~/memory.git ] || git init -q --bare -b main ~/memory.git
  [ -d ~/memory/.git ] || git clone -q ~/memory.git ~/memory 2>/dev/null || true
  mkdir -p ~/memory/global ~/memory/projects/powerhouse
  BM=~/.local/bin/basic-memory
  $BM project list 2>/dev/null | grep -q " global " || $BM project add global ~/memory/global >/dev/null
  $BM project list 2>/dev/null | grep -q " powerhouse " || $BM project add powerhouse ~/memory/projects/powerhouse >/dev/null
  $BM project default global >/dev/null
  mkdir -p ~/bin
  cat > ~/bin/memory-sync.sh <<SYNC
#!/usr/bin/env bash
# Single writer: commit whatever the server changed, integrate what the
# laptop pushed, push back. Runs from the memory-sync timer. The running
# server does not notice files that arrive via git; when a pull changed
# anything, request a reindex (memory-restart.path restarts the server).
set -euo pipefail
cd ~/memory
git add -A
git diff --cached --quiet || git commit -qm "memory: auto-commit \$(date -u +%Y-%m-%dT%H:%M:%SZ)"
before=\$(git rev-parse HEAD)
git pull -q --rebase origin main 2>/dev/null || true
git push -q origin main 2>/dev/null || true
if [ "\$(git rev-parse HEAD)" != "\$before" ] && ! git diff --quiet "\$before" HEAD -- . ; then
  touch ~/.reindex
fi
SYNC
  chmod +x ~/bin/memory-sync.sh
'

cat > /etc/systemd/system/memory.service <<'UNIT'
[Unit]
Description=Shared agent memory (Basic Memory, streamable-HTTP MCP)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=memory
Group=memory
WorkingDirectory=/home/memory
Environment=PATH=/home/memory/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/memory/.local/bin/basic-memory mcp --transport streamable-http --host 127.0.0.1 --port 8770 --path /mcp
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/memory-sync.service <<'UNIT'
[Unit]
Description=Commit and push the shared agent memory

[Service]
Type=oneshot
User=memory
Group=memory
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/home/memory/bin/memory-sync.sh
UNIT

cat > /etc/systemd/system/memory-sync.timer <<'UNIT'
[Unit]
Description=Sync the shared agent memory every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT

cat > /etc/systemd/system/memory-restart.service <<'UNIT'
[Unit]
Description=Reindex the shared agent memory after files arrived via git

[Service]
Type=oneshot
ExecStart=/bin/rm -f /home/memory/.reindex
ExecStart=/bin/systemctl restart memory.service
UNIT

cat > /etc/systemd/system/memory-restart.path <<'UNIT'
[Unit]
Description=Watch for a reindex request from the memory user

[Path]
PathExists=/home/memory/.reindex
Unit=memory-restart.service

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now memory.service memory-sync.timer memory-restart.path
systemctl is-active memory.service memory-sync.timer memory-restart.path
