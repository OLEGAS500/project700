"use client";

import type { MaintenanceWindowRecord } from "@eim/db";
import { useActionState, useState } from "react";
import { cancelMaintenanceWindowAction, type MaintenanceActionState } from "./actions";

export default function MaintenanceWindowList({ storeId, windows }: { storeId: string; windows: MaintenanceWindowRecord[] }) {
  const [now] = useState(() => Date.now());
  const groups = ["active", "upcoming", "completed", "cancelled"] as const;

  return (
    <section className="maintenance-list-section">
      <div className="detail-section-heading"><div><h2>Maintenance windows</h2><p>Store-scoped alert suppression windows and their lifecycle.</p></div></div>
      {groups.map((group) => {
        const items = windows.filter((window) => windowState(window, now) === group);
        return <WindowGroup key={group} group={group} storeId={storeId} now={now} windows={items} />;
      })}
    </section>
  );
}

function WindowGroup({ group, storeId, now, windows }: { group: string; storeId: string; now: number; windows: MaintenanceWindowRecord[] }) {
  return (
    <section className="maintenance-window-group">
      <h3>{group.charAt(0).toUpperCase() + group.slice(1)}</h3>
      {windows.length === 0 ? <p className="detail-empty">No {group} windows.</p> : windows.map((window) => <WindowRow key={window.id} storeId={storeId} now={now} window={window} />)}
    </section>
  );
}

function WindowRow({ storeId, now, window }: { storeId: string; now: number; window: MaintenanceWindowRecord }) {
  const state = windowState(window, now);

  return (
    <article className="maintenance-window-row">
      <div><strong>{window.reason}</strong><span>{formatTimestamp(window.startsAt)} to {formatTimestamp(window.endsAt)}</span><span>Created by {window.createdBy}</span></div>
      {window.cancelledAt ? (
        <span className="maintenance-cancelled">Cancelled {formatTimestamp(window.cancelledAt)}</span>
      ) : state === "active" || state === "upcoming" ? (
        <CancelForm storeId={storeId} windowId={window.id} />
      ) : (
        <span className="maintenance-completed">Completed</span>
      )}
    </article>
  );
}

function CancelForm({ storeId, windowId }: { storeId: string; windowId: string }) {
  const [state, action, pending] = useActionState(
    () => cancelMaintenanceWindowAction(storeId, windowId),
    { error: null } satisfies MaintenanceActionState
  );

  return (
    <div className="maintenance-window-action">
      <form action={action}>
        <button type="submit" disabled={pending}>{pending ? "Cancelling..." : "Cancel"}</button>
      </form>
      {state.error ? <p className="maintenance-action-error" role="alert">{state.error}</p> : null}
    </div>
  );
}

function windowState(window: MaintenanceWindowRecord, now: number): "active" | "upcoming" | "completed" | "cancelled" {
  if (window.cancelledAt) return "cancelled";
  if (new Date(window.endsAt).getTime() <= now) return "completed";
  if (new Date(window.startsAt).getTime() > now) return "upcoming";
  return "active";
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
