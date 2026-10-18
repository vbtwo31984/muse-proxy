#!/usr/bin/env bash
# Run the muse-proxy admin CLI on the VM from your laptop, e.g.
#   GCP_PROJECT=my-project deploy/admin.sh pair
#   GCP_PROJECT=my-project deploy/admin.sh alias add --label packages
set -euo pipefail
PROJECT="${GCP_PROJECT:?set GCP_PROJECT}"
ZONE="${GCP_ZONE:-us-west1-b}"
NAME="${VM_NAME:-muse-proxy}"
gcloud --project "$PROJECT" compute ssh "$NAME" --zone "$ZONE" --tunnel-through-iap -- \
  sudo docker exec muse-proxy-app muse-proxy "$(printf '%q ' "$@")"
