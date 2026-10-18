import { join } from "node:path";

export interface Config {
  /** Public hostname. Serves the API and is also the mail domain (aliases are <alias>@domain). */
  domain: string;
  dataDir: string;
  httpHost: string;
  httpPort: number;
  smtpHost: string;
  smtpPort: number;
  /** PEM files for SMTP STARTTLS. Usually Caddy's cert for `domain`. Optional: smtp-server falls back to a built-in self-signed cert. */
  tlsCertPath?: string;
  tlsKeyPath?: string;
  maxMessageBytes: number;
  aliasDailyLimit: number;
  /** Forwarders whose ARC seal we trust to vouch for DMARC after forwarding broke DKIM/SPF. */
  arcTrustedSealers: string[];
  eventRetentionDays: number;
  unackedRetentionDays: number;
  mailRetentionDays: number;
  /** POSTed to (ntfy-style plain text) when no Muse client has been connected for disconnectAlertMinutes. */
  alertUrl?: string;
  disconnectAlertMinutes: number;
  helperBundlePath: string;
  admin: {
    /** Web admin at /admin (passkey sign-in). Off unless MP_ADMIN_ENABLED=true. */
    enabled: boolean;
    /** Shown in the UI and used as the passkey's user name; not used for authentication. */
    email: string;
    sessionHours: number;
    enrollMinutes: number;
  };
}

// Large mail providers that ARC-seal what they forward (Gmail/Workspace, Microsoft 365/Outlook,
// Proton, Fastmail, iCloud, Yahoo).
const DEFAULT_ARC_TRUSTED_SEALERS =
  "google.com,microsoft.com,outlook.com,protonmail.ch,proton.me,messagingengine.com,fastmail.com,icloud.com,yahoo.com";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function opt(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const domain = overrides.domain ?? opt("MP_DOMAIN");
  if (!domain) throw new Error("MP_DOMAIN is required (e.g. muse.example.com)");
  const dataDir = overrides.dataDir ?? opt("MP_DATA_DIR") ?? "/var/lib/muse-proxy";
  return {
    domain,
    dataDir,
    httpHost: opt("MP_HTTP_HOST") ?? "0.0.0.0",
    httpPort: int("MP_HTTP_PORT", 8080),
    smtpHost: opt("MP_SMTP_HOST") ?? "0.0.0.0",
    smtpPort: int("MP_SMTP_PORT", 2525),
    tlsCertPath: opt("MP_TLS_CERT"),
    tlsKeyPath: opt("MP_TLS_KEY"),
    maxMessageBytes: int("MP_MAX_MESSAGE_BYTES", 10 * 1024 * 1024),
    aliasDailyLimit: int("MP_ALIAS_DAILY_LIMIT", 50),
    arcTrustedSealers: (opt("MP_ARC_TRUSTED_SEALERS") ?? DEFAULT_ARC_TRUSTED_SEALERS)
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    eventRetentionDays: int("MP_EVENT_RETENTION_DAYS", 30),
    unackedRetentionDays: int("MP_UNACKED_RETENTION_DAYS", 90),
    mailRetentionDays: int("MP_MAIL_RETENTION_DAYS", 30),
    alertUrl: opt("MP_ALERT_URL"),
    disconnectAlertMinutes: int("MP_DISCONNECT_ALERT_MINUTES", 30),
    helperBundlePath: opt("MP_HELPER_BUNDLE") ?? join(process.cwd(), "dist", "muse-helper.mjs"),
    admin: {
      enabled: opt("MP_ADMIN_ENABLED") === "true",
      email: opt("MP_ADMIN_EMAIL") ?? `admin@${domain}`,
      sessionHours: int("MP_ADMIN_SESSION_HOURS", 12),
      enrollMinutes: int("MP_ADMIN_ENROLL_MINUTES", 15),
    },
    ...overrides,
  };
}
