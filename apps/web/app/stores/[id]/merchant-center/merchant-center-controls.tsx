"use client";

import type {
  MerchantCenterConnectionRecord,
  MerchantCenterOAuthStatusRecord
} from "@eim/db";
import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  disconnectMerchantCenterAction,
  type MerchantCenterActionState
} from "./actions";

export default function MerchantCenterControls({
  storeId,
  status,
  connection,
  configurationAvailable
}: {
  storeId: string;
  status: MerchantCenterOAuthStatusRecord;
  connection: MerchantCenterConnectionRecord;
  configurationAvailable: boolean;
}) {
  const credentials = status.credentials;
  const [disconnectState, disconnectAction] = useActionState(
    (previousState: MerchantCenterActionState, formData: FormData) =>
      disconnectMerchantCenterAction(storeId, previousState, formData),
    { error: null } satisfies MerchantCenterActionState
  );

  return (
    <div className="merchant-center-sections">
      <section className="merchant-center-section">
        <div className="detail-section-heading">
          <div>
            <h2>Authorization</h2>
            <p>Connect a Merchant Center account through Google OAuth. Provider secrets stay server-side.</p>
          </div>
        </div>
        <StartAuthorizationButton storeId={storeId} disabled={!configurationAvailable} />
        {!configurationAvailable ? (
          <p className="merchant-center-help" role="status">OAuth configuration is unavailable in this environment.</p>
        ) : null}
      </section>

      <section className="merchant-center-section">
        <div className="detail-section-heading">
          <div>
            <h2>Account details</h2>
            <p>Only safe connection metadata is displayed.</p>
          </div>
        </div>
        <dl className="merchant-center-facts">
          <Fact label="Account ID" value={connection.merchantCenterAccountId ?? "Not linked"} />
          <Fact label="Scopes" value={credentials?.scopes.join(", ") ?? "Not available"} />
          <Fact label="Token expiry" value={credentials ? formatTimestamp(credentials.expiresAt) : "Not available"} />
          <Fact label="Credentials version" value={credentials ? String(credentials.credentialsVersion) : "Not available"} />
          <Fact label="Last updated" value={credentials ? formatTimestamp(credentials.updatedAt) : "Not available"} />
        </dl>
        {credentials ? (
          <RefreshButton
            storeId={storeId}
            disabled={!configurationAvailable || credentials.refreshInProgress}
            inProgress={credentials.refreshInProgress}
          />
        ) : null}
        {credentials && connection.merchantCenterAccountId ? (
          <DeveloperRegistrationButton storeId={storeId} disabled={!configurationAvailable} />
        ) : null}
        {credentials ? (
          <form
            action={disconnectAction}
            className="merchant-center-disconnect-form"
            onSubmit={(event) => {
              if (!window.confirm("Disconnect Merchant Center and remove stored OAuth credentials?")) {
                event.preventDefault();
              }
            }}
          >
            <DisconnectButton />
            {disconnectState.error ? <p className="merchant-center-action-error" role="alert">{disconnectState.error}</p> : null}
          </form>
        ) : null}
      </section>
    </div>
  );
}

function StartAuthorizationButton({ storeId, disabled }: { storeId: string; disabled: boolean }) {
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      className="primary-link merchant-center-start-button"
      aria-busy={pending}
      disabled={disabled || pending}
      onClick={() => {
        setPending(true);
        window.location.assign(`/api/stores/${storeId}/merchant-center/oauth/start`);
      }}
    >
      {pending ? "Opening Google..." : "Connect Merchant Center"}
    </button>
  );
}

function RefreshButton({
  storeId,
  disabled,
  inProgress
}: {
  storeId: string;
  disabled: boolean;
  inProgress: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/stores/${storeId}/merchant-center/oauth/refresh`, {
        method: "POST",
        headers: { accept: "application/json" }
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof body.error === "string" ? body.error : "Merchant Center refresh failed.");
        return;
      }
      router.refresh();
    } catch {
      setError("Merchant Center refresh is temporarily unavailable.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="merchant-center-refresh">
      <button type="button" onClick={refresh} disabled={disabled || pending}>
        {pending || inProgress ? "Refresh in progress" : "Refresh credentials"}
      </button>
      {error ? <p className="merchant-center-action-error" role="alert">{error}</p> : null}
    </div>
  );
}

function DeveloperRegistrationButton({ storeId, disabled }: { storeId: string; disabled: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function register() {
    if (!window.confirm(
      "Register the configured Google Cloud project with this Merchant Center account? This one-time action enables Merchant API calls."
    )) {
      return;
    }

    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/stores/${storeId}/merchant-center/developer-registration`, {
        method: "POST",
        headers: { accept: "application/json" }
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(
          typeof body.error === "string"
            ? body.error
            : "Merchant Center developer registration failed."
        );
        return;
      }
      setRegistered(true);
      router.refresh();
    } catch {
      setError("Merchant Center developer registration is temporarily unavailable.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="merchant-center-refresh">
      <button type="button" onClick={register} disabled={disabled || pending || registered}>
        {pending ? "Activating Merchant API..." : registered ? "Merchant API activated" : "Activate Merchant API"}
      </button>
      <p className="merchant-center-help">
        Registers the configured Google Cloud project for this linked Merchant Center account.
      </p>
      {error ? <p className="merchant-center-action-error" role="alert">{error}</p> : null}
    </div>
  );
}

function DisconnectButton() {
  const { pending } = useFormStatus();
  return <button type="submit" className="secondary-danger-button" disabled={pending}>{pending ? "Disconnecting..." : "Disconnect"}</button>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
