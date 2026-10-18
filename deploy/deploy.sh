#!/usr/bin/env bash
# Ship the committed tree (HEAD) to the VM over IAP and (re)build + restart.
#   GCP_PROJECT=my-project deploy/deploy.sh [--pull]
#
# --pull also fetches the base images again, picking up OS patches that upstream
# republishes under the same pinned tags (node, caddy, playwright).
#
# The build runs on the VM as a detached systemd unit, so a dropped SSH/IAP
# session can't kill it, and images are built one at a time because the
# e2-micro has only 1 GB of RAM.
set -euo pipefail

PROJECT="${GCP_PROJECT:?set GCP_PROJECT}"
ZONE="${GCP_ZONE:-us-west1-b}"
NAME="${VM_NAME:-muse-proxy}"
ROOT="$(git rev-parse --show-toplevel)"
REV="$(git -C "$ROOT" rev-parse --short HEAD)"
UNIT="muse-proxy-deploy-$REV-$(date +%s)"
PULL=""
case "${1:-}" in --pull) PULL="--pull" ;; "") ;; *) echo "usage: deploy.sh [--pull]" >&2; exit 2 ;; esac
TARBALL="$(mktemp -t muse-proxy-XXXXXX).tar.gz"
trap 'rm -f "$TARBALL"' EXIT

git -C "$ROOT" diff --quiet HEAD || echo "warning: uncommitted changes are NOT deployed (deploying $REV)"
git -C "$ROOT" archive --format=tar.gz -o "$TARBALL" HEAD

ssh_vm() { gcloud --project "$PROJECT" compute ssh "$NAME" --zone "$ZONE" --tunnel-through-iap --quiet --command "$1" 2> >(grep -v -e NumPy -e increasing_the_tcp -e '^$' >&2); }

gcloud --project "$PROJECT" compute scp --zone "$ZONE" --tunnel-through-iap --quiet "$TARBALL" "$NAME:/tmp/muse-proxy.tar.gz"
ssh_vm "set -e
  test -f /opt/muse-proxy/.env || { echo 'missing /opt/muse-proxy/.env (copy deploy/.env.example, chmod 600)'; exit 1; }
  sudo rm -rf /opt/muse-proxy/src.new && sudo mkdir -p /opt/muse-proxy/src.new
  sudo tar -xzf /tmp/muse-proxy.tar.gz -C /opt/muse-proxy/src.new && rm /tmp/muse-proxy.tar.gz
  sudo rm -rf /opt/muse-proxy/src.old && { [ ! -d /opt/muse-proxy/src ] || sudo mv /opt/muse-proxy/src /opt/muse-proxy/src.old; }
  sudo mv /opt/muse-proxy/src.new /opt/muse-proxy/src
  sudo systemd-run --unit '$UNIT' --collect --working-directory /opt/muse-proxy/src/deploy /bin/sh -c '
    set -e
    C=\"docker compose --env-file /opt/muse-proxy/.env\"
    \$C build $PULL app
    \$C build $PULL browser
    ${PULL:+\$C pull caddy}
    \$C up -d --remove-orphans
    docker image prune -f >/dev/null
    \$C ps
    echo DEPLOY_OK'"

echo "build running on the VM as $UNIT; following its log (Ctrl-C is safe, the build continues)..."
for _ in $(seq 1 120); do
  sleep 15
  out="$(ssh_vm "sudo journalctl -u '$UNIT' --no-pager -o cat | tail -n 4; systemctl is-active '$UNIT' 2>/dev/null || true" 2>/dev/null || true)"
  [[ -n "$out" ]] && printf '%s\n' "$out" | tail -n 5
  if grep -q DEPLOY_OK <<<"$out"; then echo "deployed $REV"; exit 0; fi
  if grep -qx failed <<<"$out"; then echo "deploy failed; see: sudo journalctl -u $UNIT" >&2; exit 1; fi
  if grep -qx inactive <<<"$out" && ! grep -q DEPLOY_OK <<<"$out"; then
    ssh_vm "sudo journalctl -u '$UNIT' --no-pager -o cat | tail -n 30" || true
    echo "deploy unit exited without DEPLOY_OK" >&2
    exit 1
  fi
done
echo "still running after 30 min; check: sudo journalctl -fu $UNIT" >&2
exit 1
