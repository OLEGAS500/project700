import { loadMerchantCenterOAuthConfiguration } from "@eim/core";
import {
  getMerchantCenterConnection,
  getMerchantCenterOAuthStatus,
  getStore
} from "@eim/db";
import type {
  MerchantCenterConnectionRecord,
  MerchantCenterOAuthStatusRecord,
  StoreSummary
} from "@eim/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import MerchantCenterControls from "./merchant-center-controls";

export const dynamic = "force-dynamic";

type SearchParams = { oauth?: string | string[] };

export default async function MerchantCenterPage({
  params,
  searchParams
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<SearchParams>;
}) {
  const { id } = await params;
  let store: StoreSummary | null;

  try {
    store = await getStore(id);
  } catch {
    return <MerchantCenterState />;
  }

  if (!store) notFound();

  let status: MerchantCenterOAuthStatusRecord | null;
  let connection: MerchantCenterConnectionRecord | null;
  try {
    [status, connection] = await Promise.all([
      getMerchantCenterOAuthStatus(id),
      getMerchantCenterConnection(id)
    ]);
  } catch {
    return <MerchantCenterState />;
  }

  if (!status || !connection) notFound();

  let configurationAvailable = true;
  try {
    loadMerchantCenterOAuthConfiguration();
  } catch {
    configurationAvailable = false;
  }

  const query = await searchParams;
  const outcome = firstQueryValue(query?.oauth);

  return (
    <main className="dashboard-shell merchant-center-shell">
      <header className="dashboard-header">
        <div>
          <Link className="product-mark" href="/dashboard">EIM</Link>
          <h1>Merchant Center</h1>
          <p>{store.name} <span className="merchant-center-domain">{store.domain}</span></p>
        </div>
        <Link className="back-link" href="/dashboard">Stores overview</Link>
      </header>

      <OAuthOutcome outcome={outcome} />

      <section className="merchant-center-overview" aria-label="Merchant Center connection status">
        <div>
          <p className="merchant-center-eyebrow">Connection</p>
          <h2>{connectionLabel(status.credentials, configurationAvailable)}</h2>
          <p className="merchant-center-copy">OAuth credentials are encrypted and never shown in this interface.</p>
        </div>
        <StatusBadge credentials={status.credentials} configurationAvailable={configurationAvailable} />
      </section>

      <MerchantCenterControls
        storeId={id}
        status={status}
        connection={connection}
        configurationAvailable={configurationAvailable}
      />
    </main>
  );
}

function OAuthOutcome({ outcome }: { outcome: string | null }) {
  const content = {
    connected: ["success", "Merchant Center connected.", "The authorization completed successfully."],
    disconnected: ["success", "Merchant Center disconnected.", "Stored OAuth credentials were removed."],
    cancelled: ["attention", "Authorization cancelled.", "No Merchant Center credentials were changed."],
    configuration_unavailable: ["failure", "Merchant Center configuration is unavailable.", "Ask an administrator to configure the runtime OAuth variables."],
    reconnect_required: ["attention", "Reconnect required.", "The authorization session is no longer valid. Start a new connection."],
    error: ["failure", "Merchant Center authorization could not be completed.", "Start the connection again or try later."]
  } as const;
  const selected = outcome && outcome in content ? content[outcome as keyof typeof content] : null;

  if (!selected) return null;

  return (
    <section className={`merchant-center-banner merchant-center-banner-${selected[0]}`} role="status">
      <strong>{selected[1]}</strong>
      <span>{selected[2]}</span>
    </section>
  );
}

function StatusBadge({
  credentials,
  configurationAvailable
}: {
  credentials: MerchantCenterOAuthStatusRecord["credentials"];
  configurationAvailable: boolean;
}) {
  const tone = !configurationAvailable
    ? "failure"
    : credentials?.refreshInProgress
      ? "attention"
      : credentials && isExpired(credentials.expiresAt)
        ? "attention"
        : credentials
          ? "success"
          : "neutral";
  const label = !configurationAvailable
    ? "Configuration unavailable"
    : credentials?.refreshInProgress
      ? "Refresh in progress"
      : credentials && isExpired(credentials.expiresAt)
        ? "Token expired"
        : credentials
          ? "Connected"
          : "Not connected";

  return <span className={`merchant-center-status merchant-center-status-${tone}`}>{label}</span>;
}

function connectionLabel(
  credentials: MerchantCenterOAuthStatusRecord["credentials"],
  configurationAvailable: boolean
): string {
  if (!configurationAvailable) return "Configuration unavailable";
  if (!credentials) return "Not connected";
  if (credentials.refreshInProgress) return "Refresh in progress";
  if (isExpired(credentials.expiresAt)) return "Token expired";
  return "Connected";
}

function MerchantCenterState() {
  return (
    <main className="dashboard-shell merchant-center-shell">
      <Link className="back-link" href="/dashboard">Stores overview</Link>
      <section className="incident-state incident-state-failure" role="alert">
        <h1>Merchant Center data is unavailable</h1>
        <p>The connection status could not be read right now. Try again later.</p>
        <Link href="/dashboard">Back to dashboard</Link>
      </section>
    </main>
  );
}

function firstQueryValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function isExpired(value: string): boolean {
  return new Date(value).getTime() <= Date.now();
}
