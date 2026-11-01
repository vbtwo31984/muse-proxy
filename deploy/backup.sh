#!/usr/bin/env bash
# Nightly off-box backup (install on the VM via root crontab, e.g. "17 3 * * * /opt/muse-proxy/src/deploy/backup.sh").
# Encrypts with age to a public key and uploads with rclone (e.g. a Cloudflare R2 remote). Both are optional;
# without them the backup just stays on the VM in /opt/muse-proxy/data/app/backups.
#   BACKUP_AGE_RECIPIENT=age1...  BACKUP_RCLONE_DEST=r2:muse-proxy-backups  (set in /opt/muse-proxy/.env)
set -euo pipefail
set -a; . /opt/muse-proxy/.env; set +a
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DIR=/opt/muse-proxy/data/app/backups
install -d -m 0700 -o 1000 -g 1000 "$DIR"
docker exec muse-proxy-app muse-proxy backup "/var/lib/muse-proxy/backups/muse-proxy-$STAMP.sqlite"
FILE="$DIR/muse-proxy-$STAMP.sqlite"
cp /opt/muse-proxy/data/app/server.key "$DIR/server-$STAMP.key"
# Invitation pictures live next to the database; include them if there are any.
EXTRA=()
[[ -d /opt/muse-proxy/data/app/invites ]] && EXTRA=(-C /opt/muse-proxy/data/app invites)
tar -C "$DIR" -czf "$FILE.tgz" "$(basename "$FILE")" "server-$STAMP.key" "${EXTRA[@]}"
rm -f "$FILE" "$DIR/server-$STAMP.key"
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]] && command -v age >/dev/null; then
  age -r "$BACKUP_AGE_RECIPIENT" -o "$FILE.tgz.age" "$FILE.tgz" && rm -f "$FILE.tgz"
fi
if [[ -n "${BACKUP_RCLONE_DEST:-}" ]] && command -v rclone >/dev/null; then
  rclone copy "$DIR" "$BACKUP_RCLONE_DEST" --include "muse-proxy-$STAMP*"
fi
find "$DIR" -type f -mtime +14 -delete
