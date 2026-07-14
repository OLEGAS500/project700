import type { IncidentStatus, IncidentType } from "@eim/core";
import type pg from "pg";
import { getAlertPreferences } from "./alert-preferences";
import { getActiveMaintenanceWindow } from "./maintenance-windows";

export type AlertType = "incident_opened" | "incident_worsened" | "incident_resolved";
type AlertChannel = "email" | "telegram";

type AlertDeliveryRow = {
  id: string;
  incident_id: string;
  store_id: string;
  incident_event_id: string;
  channel: AlertChannel;
  alert_type: AlertType;
  status: "pending" | "suppressed" | "sent" | "failed";
  primary_suppression_reason: string | null;
  maintenance_window_id: string | null;
  alert_preference_version: number;
  alert_preference_hash: string;
  created_at: Date;
  sent_at: Date | null;
};

export type AlertDeliveryRecord = {
  id: string;
  incidentId: string;
  storeId: string;
  eventId: string;
  channel: AlertChannel;
  alertType: AlertType;
  status: "pending" | "suppressed" | "sent" | "failed";
  suppressionReason: string | null;
  maintenanceWindowId: string | null;
  alertPreferenceVersion: number;
  alertPreferenceHash: string;
  createdAt: string;
  sentAt: string | null;
};

export async function createIncidentOpenedAlertDelivery(
  client: pg.PoolClient,
  input: { incidentId: string; storeId: string; snapshotId: string | null }
): Promise<AlertDeliveryRecord[]> {
  const eventId = await getOrCreateIncidentOpenedEvent(client, input);
  return createAlertDeliveriesForIncidentEvent(client, {
    incidentId: input.incidentId,
    eventId,
    alertType: "incident_opened"
  });
}

export async function createAlertDeliveriesForIncidentEvent(
  client: pg.PoolClient,
  input: { incidentId: string; eventId: string; alertType: AlertType }
): Promise<AlertDeliveryRecord[]> {
  const incident = await client.query<{
    store_id: string;
    type: IncidentType;
    status: IncidentStatus;
  }>("SELECT store_id, type, status FROM incidents WHERE id = $1", [input.incidentId]);
  const current = incident.rows[0];
  if (!current) throw new Error(`Incident ${input.incidentId} was not found for alert delivery`);

  const [preferences, maintenanceWindow] = await Promise.all([
    getAlertPreferences(current.store_id, client),
    getActiveMaintenanceWindow(client, current.store_id)
  ]);
  const deliveries: AlertDeliveryRecord[] = [];

  for (const channel of ["email", "telegram"] as const) {
    const decision = decideDelivery({
      channel,
      alertType: input.alertType,
      incidentType: current.type,
      preferences: preferences.preferences,
      maintenanceWindowId: maintenanceWindow?.id ?? null
    });
    const inserted = await client.query<AlertDeliveryRow>(
      `
        INSERT INTO alert_deliveries (
          incident_id, store_id, incident_event_id, channel, alert_type, status,
          primary_suppression_reason, maintenance_window_id,
          alert_preference_version, alert_preference_hash, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp())
        ON CONFLICT (incident_event_id, channel) DO NOTHING
        RETURNING *
      `,
      [
        input.incidentId,
        current.store_id,
        input.eventId,
        channel,
        input.alertType,
        decision.reason ? "suppressed" : "pending",
        decision.reason,
        decision.reason === "maintenance_window" ? maintenanceWindow?.id ?? null : null,
        preferences.alertPreferenceVersion,
        preferences.configurationHash
      ]
    );
    const delivery = inserted.rows[0];

    if (delivery && decision.reason) {
      await insertSuppressionEvent(client, {
        incidentId: input.incidentId,
        storeId: current.store_id,
        status: current.status,
        deliveryId: delivery.id,
        alertType: input.alertType,
        channel,
        reason: decision.reason,
        maintenanceWindowId: maintenanceWindow?.id ?? null
      });
    }

    if (delivery) {
      deliveries.push(mapAlertDelivery(delivery));
      continue;
    }

    const existing = await client.query<AlertDeliveryRow>(
      "SELECT * FROM alert_deliveries WHERE incident_event_id = $1 AND channel = $2",
      [input.eventId, channel]
    );
    deliveries.push(mapAlertDelivery(existing.rows[0]));
  }

  return deliveries;
}

function decideDelivery(input: {
  channel: AlertChannel;
  alertType: AlertType;
  incidentType: IncidentType;
  preferences: Awaited<ReturnType<typeof getAlertPreferences>>["preferences"];
  maintenanceWindowId: string | null;
}): { reason: string | null } {
  const preferences = input.preferences;
  if (!preferences.enabled) return { reason: "alerts_disabled" };
  if (input.channel === "email" && !preferences.emailEnabled) return { reason: "channel_disabled" };
  if (input.channel === "telegram" && !preferences.telegramEnabled) return { reason: "channel_disabled" };
  if (preferences.mutedIncidentTypes.includes(input.incidentType)) return { reason: "incident_type_muted" };
  if (input.alertType === "incident_opened" && !preferences.notifyOnOpen) return { reason: "open_notifications_disabled" };
  if (input.alertType === "incident_worsened" && !preferences.notifyOnWorsening) return { reason: "worsening_notifications_disabled" };
  if (input.alertType === "incident_resolved" && !preferences.notifyOnRecovery) return { reason: "recovery_notifications_disabled" };
  if (input.maintenanceWindowId) return { reason: "maintenance_window" };
  return { reason: null };
}

async function insertSuppressionEvent(
  client: pg.PoolClient,
  input: {
    incidentId: string;
    storeId: string;
    status: IncidentStatus;
    deliveryId: string;
    alertType: AlertType;
    channel: AlertChannel;
    reason: string;
    maintenanceWindowId: string | null;
  }
): Promise<void> {
  await client.query(
    `
      INSERT INTO incident_events (
        incident_id, store_id, event_type, from_status, to_status, message, metadata_json, created_at
      )
      VALUES ($1, $2, 'alert_suppressed', $3, $3, $4, $5::jsonb, clock_timestamp())
    `,
    [
      input.incidentId,
      input.storeId,
      input.status,
      "Alert delivery suppressed by current alert preferences.",
      JSON.stringify({
        reason: input.reason,
        maintenanceWindowId: input.maintenanceWindowId,
        alertType: input.alertType,
        channel: input.channel,
        alertDeliveryId: input.deliveryId
      })
    ]
  );
}

async function getOrCreateIncidentOpenedEvent(
  client: pg.PoolClient,
  input: { incidentId: string; storeId: string; snapshotId: string | null }
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `
      INSERT INTO incident_events (incident_id, store_id, event_type, to_status, message, metadata_json, created_at)
      VALUES ($1, $2, 'incident_opened', 'open', $3, $4::jsonb, clock_timestamp())
      ON CONFLICT (incident_id) WHERE event_type = 'incident_opened' DO NOTHING
      RETURNING id
    `,
    [input.incidentId, input.storeId, "Incident opened and alert intents created.", JSON.stringify({ snapshotId: input.snapshotId })]
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM incident_events WHERE incident_id = $1 AND event_type = 'incident_opened' LIMIT 1",
    [input.incidentId]
  );
  return existing.rows[0].id;
}

function mapAlertDelivery(row: AlertDeliveryRow): AlertDeliveryRecord {
  return {
    id: row.id,
    incidentId: row.incident_id,
    storeId: row.store_id,
    eventId: row.incident_event_id,
    channel: row.channel,
    alertType: row.alert_type,
    status: row.status,
    suppressionReason: row.primary_suppression_reason,
    maintenanceWindowId: row.maintenance_window_id,
    alertPreferenceVersion: row.alert_preference_version,
    alertPreferenceHash: row.alert_preference_hash,
    createdAt: row.created_at.toISOString(),
    sentAt: row.sent_at?.toISOString() ?? null
  };
}
