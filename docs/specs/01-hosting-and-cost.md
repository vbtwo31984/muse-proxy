# 01 — Hosting options and cost

Status: **Approved 2026-10-10**. Researched 2026-10-10.

## What we need to host

| Need | Implication |
|---|---|
| Muse can only connect **outbound** | We need a public endpoint Muse dials into and keeps open (WebSocket), and that queues events while Muse is disconnected. |
| Inbound **email** forwarded to Muse | Something must accept SMTP on port 25 for a subdomain and turn each message into an event. Receive-only: we never send mail, so the outbound port 25 blocks most clouds apply, and IP reputation, don't matter. |
| **Fetch proxies** for sites that block Muse (USPS first) | Server-side code that calls an API or scrapes a site and returns clean JSON. A headless browser may be needed later for sites with no API. |
| Low traffic, one user | A small instance is enough. The core services need ~300 MB. A **headless browser (Playwright/Chromium)** for scraping needs ~0.5–1 GB more, so 1 GB is tight but workable when the browser is launched on demand. 2 GB+ is comfortable. |

## Options compared

Prices change often. Hetzner raised prices on 2026-04-01 and again for new orders on 2026-06-15. AWS, GCP, and Azure bill public IPv4 addresses separately (AWS ~$3.65/mo, GCP ~$2.92/mo). **GCP's free tier does not cover the external IP.** Check each provider's console or calculator before buying.

### Big cloud providers (cheapest instances, US East, on-demand)

| Option | Specs | Approx. monthly cost | Notes |
|---|---|---|---|
| **GCP e2-micro (Always Free)** | 2 shared vCPU (≈¼ core sustained, bursts), 1 GB RAM, 30 GB standard disk | **~$2.92** (VM and disk free, plus external IPv4 at ~$0.004/hr) | Free only in **us-west1, us-central1, us-east1**. 1 GB/month free egress, which is plenty for text events. Permanent free tier, with no idle reclamation. |
| AWS EC2 t4g.nano | 2 vCPU (burst), 0.5 GB RAM | ~$3.07 + **$3.65 IPv4** + ~$0.65 for 8 GB gp3 ≈ **$7.40** | New accounts get $100–200 in credits that expire after 6–12 months. 0.5 GB RAM is tight. |
| AWS EC2 t4g.micro | 2 vCPU, 1 GB RAM | ≈ **$10.50** | |
| AWS Lightsail | 0.5–1 GB RAM | $5–7 (IPv4 included) | Flat-price VPS. Specs comparable to DigitalOcean or Vultr. |
| Azure B1ls | 1 vCPU, 0.5 GB RAM | ~$3.80 + ~$3.65 IPv4 + ~$1.50 disk ≈ **$9** | The free account only lasts 12 months. |
| Azure B2pts v2 (ARM) | 2 vCPU, 1 GB RAM | ≈ **$11** | |
| Oracle Always Free (Ampere A1) | Up to 4 OCPU / 24 GB | $0 | Idle instances get reclaimed, ARM capacity is often unavailable, and there are account-termination stories. Not reliable for an always-on listener. |

### VPS providers

| Option | Approx. monthly cost | Inbound :25 | Notes |
|---|---|---|---|
| Hetzner Cloud CX23 (Germany/Finland), 2 vCPU x86 / 4 GB / 40 GB, 20 TB traffic | $6.49 + IPv4 (~$0.60) ≈ $7.10 | Open | **All cloud servers showed as "currently not available" for new orders on 2026-10-10.** Best specs per dollar, with room for a headless browser. The ARM CAX11 is now *more* expensive ($6.99). US locations are far pricier after June 2026: CPX11 (2 GB) is $20.49. |
| OVH VPS Starter | ~$4–7 | Open | Cheap. Weaker console. |
| Vultr 1 GB | $5–6 | Inbound OK | 1 GB RAM. |
| DigitalOcean 1 GB | $6 | Inbound OK | Polished, but pricier per GB. |

### Serverless

| Option | Approx. monthly cost | Notes |
|---|---|---|
| Cloudflare-only (Workers + Durable Objects + Email Routing → Email Worker) | $0 free tier / $5 Workers Paid | No server to patch. WebSocket Hibernation means idle connections aren't billed. No real mail server. Tight per-invocation CPU limits on the free tier. No cheap headless browser. More lock-in. |

**Port 25:** AWS, GCP, and Azure block **outbound** port 25 by default. **Inbound** works on all of them, and that's all we need.

## Recommendation

**GCP Compute Engine e2-micro (Always Free tier) in `us-west1` (Oregon, zone `us-west1-b`), with DNS on Cloudflare (free). About $3/month, all of it for the IPv4 address.**
**Upgrade in place to `e2-small` (2 GB, ≈ $15/mo total) only if the headless browser proves too heavy.**

Hetzner, our first choice for its 4 GB RAM at ~$7, had no cloud servers available for new orders on 2026-10-10.

Why this works:
- **About $3/month**, and permanent, unlike AWS and Azure free tiers (12 months or credit-based) or Oracle (reclaims idle instances).
- The core services (Caddy, the Node app, SQLite) use ~300 MB.
- **Headless browser on 1 GB:** Chromium is launched **on demand**, one page at a time, with images, media, and fonts blocked, then closed after each call. That's ~250–400 MB while running and zero when idle. A 2 GB swap file absorbs spikes. Expect slow page loads (~5–20 s) because e2-micro only sustains about ¼ of a CPU core. That's fine for occasional lookups such as package tracking.
- **US datacenter IP:** no geo-blocking problem for US sites like usps.com. Bot protection can still block datacenter IPs. The fix is the optional home Tailscale exit node (spec 02 §7.5).
- **Easy upgrade:** stop the VM, change the machine type to `e2-small` (2 vCPU burst, 2 GB) or `e2-medium` (4 GB), and start it again. The static IP, disk, and DNS all stay the same. Only `e2-micro` is free, so e2-small is ~$12.20/mo plus the IP (≈ $15 total), and e2-medium ≈ $27.
- Plain Docker Compose with no GCP-specific services, so moving providers later (e.g. back to Hetzner when it has stock) is just redeploying and updating DNS.

### GCP free-tier gotchas (to avoid surprise bills)
- The region must be **us-west1, us-central1, or us-east1**. Machine type **e2-micro**. Only **one** instance.
- The boot disk must be **"Standard persistent disk" (pd-standard), ≤ 30 GB**. The console defaults to *Balanced*, which is **not** free.
- **External IPv4:** the MX record needs a stable address, so we reserve a **static** external IP. The free tier doesn't cover it: an in-use IPv4 is ~$0.004/hr, about **$2.92/mo**. A *reserved but unattached* static IP is billed at a higher rate, so release it if the VM is deleted.
- **Egress:** 1 GB/month free (excluding China and Australia), then ~$0.12/GB. Our outbound traffic is small: events, API responses, and browser *requests*. Page downloads are **ingress**, which is free. Large email attachments are never pushed to Muse automatically (spec 02 §6.2).
- Set a **billing budget alert at $5** on day one. That covers the IP plus a margin, so anything unexpected gets flagged.
- No snapshot schedule (those are billed). We back up SQLite off-box ourselves (nightly, encrypted, to the Cloudflare R2 free tier).

### Region choice: `us-west1` (Oregon)

| | us-west1 (Oregon) | us-central1 (Iowa) | us-east1 (S. Carolina) |
|---|---|---|---|
| Free-tier eligible | Yes | Yes | Yes |
| Price (IPv4, egress) | Same | Same | Same |
| Google carbon-free energy | **87%** | 87% | 31% |
| Grid intensity (gCO2eq/kWh) | **79** | 413 | 576 |
| Latency | Irrelevant for this workload. Under 80 ms to anywhere in the continental US. | | |

Price and features are identical, so the tie-breaker is that Oregon runs on the cleanest power. us-central1 is the fallback if e2-micro capacity in us-west1 is ever unavailable.

### Total monthly cost estimate

| Item | e2-micro (plan) | e2-small (if needed) |
|---|---|---|
| Compute | $0 (free tier) | ~$12.20 |
| Static IPv4 | ~$2.92 | ~$2.92 |
| Disk (30 GB pd-standard) | $0 | $0 (still within the free 30 GB) |
| Egress | $0 (≤ 1 GB) | $0 (≤ 1 GB) |
| Cloudflare DNS (proxy **off** for mail records) | $0 | $0 |
| TLS certificates (Let's Encrypt via Caddy) | $0 | $0 |
| USPS Business Account + Tracking API | $0 | $0 |
| Tailscale (optional home exit node) | $0 | $0 |
| Off-box backups (Cloudflare R2 free tier) | $0 | $0 |
| Uptime monitoring (healthchecks.io / UptimeRobot free) | $0 | $0 |
| **Total** | **≈ $3 / month** | **≈ $15 / month** |

## Architecture at a glance

```
                      ┌─────────────── VM: GCP e2-micro (us-west1) · Debian 13 · Docker ───────────┐
 Internet mail ─:25──▶│  app container (single Node/TS process)                                    │
 (MX for muse.<dom>)  │   ├─ SMTP ingest (receive-only, STARTTLS, SPF/DKIM/DMARC, size limits)     │
                      │   ├─ Event store (SQLite: events, acks, raw .eml retention)                │
 Your scripts ─HTTPS─▶│   ├─ Publish API (scoped publisher keys)                                   │
                      │   ├─ WebSocket hub (mutual Ed25519 challenge-response, seq/ack, replay)    │
                      │   └─ Connectors (usps.track, …; allowlisted, never an open proxy)          │
                      │          │                                                                 │
                      │          ▼                                                                 │
                      │  browser container (on-demand Chromium; no secrets, no DB, egress only)    │
 Muse Helper ─wss:443▶│  Caddy (auto Let's Encrypt for muse.<dom>) ──▶ app :8080                   │
 (outbound only)      └────────────────────────────────────────────────────────────────────────────┘
                         firewall: 25, 80, 443 open; SSH only via Google IAP tunnel
```

## Sources

- [GCP Free Tier features](https://docs.cloud.google.com/free/docs/free-cloud-features), [GCP Free Tier 2026 guide](https://agentdeals.dev/gcp-free-tier-2026), [GCP region carbon data](https://cloud.google.com/sustainability/region-carbon)
- [AWS public IPv4 charge](https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights), [t4g.nano pricing](https://calculator.holori.com/aws/ec2/t4g.nano/us-east-1), [AWS Free Tier 2026 changes](https://infratally.com/articles/aws-free-tier-2026/)
- [Azure B1ls pricing](https://calculator.holori.com/azure/vm/standard-b1ls), [Azure B2pts v2 pricing](https://calculator.holori.com/azure/vm/standard-b2pts-v2/eastus)
- [Hetzner price adjustment (official)](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), [Hetzner 2026 pricing (agentdeals)](https://agentdeals.dev/hetzner-pricing-2026), [Hetzner June 2026 increase](https://privatedevops.com/news/hetzner-june-2026-cloud-price-increase-what-to-do), [Hetzner changelog](https://docs.hetzner.cloud/whats-new)
- [Cheapest VPS 2026 comparison](https://aibizhub.io/articles/cheapest-vps-hetzner-vs-digitalocean-vs-vultr-2026/), [Port 25 by provider](https://mailflowauthority.com/self-hosted-smtp/digitalocean-vs-hetzner-vs-vultr-email)
- [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing), [Email Routing limits](https://developers.cloudflare.com/email-routing/limits)
- [USPS Tracking API](https://developers.usps.com/trackingv3), [USPS API access policy](https://www.usps.com/business/api-access.htm), [USPS APIs onboarding guide](https://www.usps.com/business/web-tools-apis/onboarding-guide.pdf), [USPS dev portal: getting started](https://devs.usps.com/getting-started)
- [Meta Muse overview (aicybr)](https://aicybr.com/blog/meta-muse-personal-ai-agent)
