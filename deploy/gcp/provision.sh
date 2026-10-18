#!/usr/bin/env bash
# One-time GCP setup for muse-proxy: dedicated VPC, firewall, static IP, free-tier
# e2-micro VM, and (optionally) a $5 budget alert. Safe to re-run: existing
# resources are left alone.
#
#   GCP_PROJECT=my-project MP_DOMAIN=muse.example.com [BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX] deploy/gcp/provision.sh
set -euo pipefail

PROJECT="${GCP_PROJECT:?set GCP_PROJECT}"
REGION="${GCP_REGION:-us-west1}"
ZONE="${GCP_ZONE:-us-west1-b}"
NAME="${VM_NAME:-muse-proxy}"
DOMAIN="${MP_DOMAIN:?set MP_DOMAIN}"
NETWORK="${NAME}-net"
HERE="$(cd "$(dirname "$0")" && pwd)"

g() { gcloud --project "$PROJECT" "$@"; }
exists() { "$@" >/dev/null 2>&1; }

g services enable compute.googleapis.com iap.googleapis.com

# A dedicated network has none of the default network's allow-all SSH/RDP rules.
exists g compute networks describe "$NETWORK" || g compute networks create "$NETWORK" --subnet-mode=auto

exists g compute firewall-rules describe "${NAME}-public" || g compute firewall-rules create "${NAME}-public" \
  --network "$NETWORK" --direction INGRESS --action ALLOW --rules tcp:25,tcp:80,tcp:443 \
  --source-ranges 0.0.0.0/0 --target-tags "$NAME"

# SSH only through Identity-Aware Proxy (gcloud compute ssh --tunnel-through-iap).
exists g compute firewall-rules describe "${NAME}-iap-ssh" || g compute firewall-rules create "${NAME}-iap-ssh" \
  --network "$NETWORK" --direction INGRESS --action ALLOW --rules tcp:22 \
  --source-ranges 35.235.240.0/20 --target-tags "$NAME"

exists g compute addresses describe "${NAME}-ip" --region "$REGION" || g compute addresses create "${NAME}-ip" --region "$REGION"
IP="$(g compute addresses describe "${NAME}-ip" --region "$REGION" --format='value(address)')"

if ! exists g compute instances describe "$NAME" --zone "$ZONE"; then
  # Free tier: e2-micro, pd-standard (NOT the console's default "balanced"), <= 30 GB, us-west1/us-central1/us-east1.
  g compute instances create "$NAME" \
    --zone "$ZONE" \
    --machine-type e2-micro \
    --network "$NETWORK" \
    --address "$IP" \
    --tags "$NAME" \
    --image-family debian-13 --image-project debian-cloud \
    --boot-disk-size 30GB --boot-disk-type pd-standard \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --metadata enable-oslogin=TRUE \
    --metadata-from-file startup-script="$HERE/startup.sh"
fi

if [[ -n "${BILLING_ACCOUNT:-}" ]]; then
  g services enable billingbudgets.googleapis.com
  if ! gcloud billing budgets list --billing-project "$PROJECT" --billing-account "$BILLING_ACCOUNT" --format='value(displayName)' | grep -qx "$NAME"; then
    gcloud billing budgets create --billing-project "$PROJECT" --billing-account "$BILLING_ACCOUNT" --display-name "$NAME" \
      --budget-amount 5USD --threshold-rule percent=0.6 --threshold-rule percent=1.0 \
      --filter-projects "projects/$PROJECT"
  fi
else
  echo "note: set BILLING_ACCOUNT to also create a \$5 budget alert (recommended)."
fi

cat <<MSG

VM ready. Static IP: $IP

DNS records to create (Cloudflare: proxy OFF / "DNS only" for all of them):
  $DOMAIN.          A     $IP
  $DOMAIN.          MX 10 $DOMAIN.
  $DOMAIN.          TXT   "v=spf1 -all"
  _dmarc.$DOMAIN.   TXT   "v=DMARC1; p=reject"

Optional reverse DNS (after verifying the domain in Search Console):
  gcloud compute instances update-access-config $NAME --zone $ZONE --public-ptr --public-ptr-domain $DOMAIN.

The VM installs Docker on first boot (a few minutes). Then: deploy/deploy.sh
MSG
