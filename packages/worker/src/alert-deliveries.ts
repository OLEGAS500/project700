import {
  claimDueAlertDeliveries,
  markAlertDeliveryAttemptFailed,
  markAlertDeliverySent,
  type AlertDeliveryChannel
} from "@eim/db";
import {
  renderEmailAlert,
  renderTelegramAlert,
  type AlertType,
  type RenderedEmailAlert,
  type RenderedTelegramAlert
} from "@eim/core";

export type AlertDeliveryMessage =
  | {
      deliveryId: string;
      incidentEventId: string;
      alertType: AlertType;
      channel: "telegram";
      content: RenderedTelegramAlert;
    }
  | {
      deliveryId: string;
      incidentEventId: string;
      alertType: AlertType;
      channel: "email";
      content: RenderedEmailAlert;
    };

export type AlertDeliverySender = {
  send(message: AlertDeliveryMessage): Promise<{ providerMessageId: string }>;
};

export type RunAlertDeliveryBatchInput = {
  channel: AlertDeliveryChannel;
  workerId: string;
  sender: AlertDeliverySender;
  limit?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
};

export type AlertDeliveryBatchResult = {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
};

export async function runAlertDeliveryBatch(
  input: RunAlertDeliveryBatchInput
): Promise<AlertDeliveryBatchResult> {
  const deliveries = await claimDueAlertDeliveries({
    channel: input.channel,
    workerId: input.workerId,
    limit: input.limit,
    leaseSeconds: input.leaseSeconds,
    maxAttempts: input.maxAttempts
  });
  const result: AlertDeliveryBatchResult = {
    claimed: deliveries.length,
    sent: 0,
    retried: 0,
    failed: 0
  };

  for (const delivery of deliveries) {
    try {
      const sent = await input.sender.send(renderAlertDeliveryMessage(delivery));
      const marked = await markAlertDeliverySent({
        deliveryId: delivery.id,
        workerId: input.workerId,
        claimedAttemptCount: delivery.attemptCount,
        providerMessageId: sent.providerMessageId
      });
      if (marked?.status === "sent") result.sent += 1;
    } catch (error) {
      const marked = await markAlertDeliveryAttemptFailed({
        deliveryId: delivery.id,
        workerId: input.workerId,
        claimedAttemptCount: delivery.attemptCount,
        error,
        maxAttempts: input.maxAttempts
      });
      if (marked?.status === "failed") {
        result.failed += 1;
      } else if (marked?.status === "pending") {
        result.retried += 1;
      }
    }
  }

  return result;
}

function renderAlertDeliveryMessage(
  delivery: Awaited<ReturnType<typeof claimDueAlertDeliveries>>[number]
): AlertDeliveryMessage {
  const common = {
    deliveryId: delivery.id,
    incidentEventId: delivery.incidentEventId,
    alertType: delivery.alertType
  };

  if (delivery.channel === "telegram") {
    return {
      ...common,
      channel: "telegram",
      content: renderTelegramAlert(delivery.payload)
    };
  }

  return {
    ...common,
    channel: "email",
    content: renderEmailAlert(delivery.payload)
  };
}
