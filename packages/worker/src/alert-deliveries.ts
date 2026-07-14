import {
  claimDueAlertDeliveries,
  getTelegramDestination,
  markAlertDeliveryAttemptFailed,
  markAlertDeliveryConfigurationFailed,
  markAlertDeliverySent,
  type AlertDeliveryConfigurationErrorCode,
  type AlertDeliveryChannel
} from "@eim/db";
import {
  renderEmailAlert,
  renderTelegramAlert,
  type AlertType,
  type RenderedEmailAlert,
  type RenderedTelegramAlert
} from "@eim/core";

export type TelegramSendRequest = {
  deliveryId: string;
  incidentEventId: string;
  alertType: AlertType;
  channel: "telegram";
  destination: {
    chatId: string;
    threadId: number | null;
  };
  content: RenderedTelegramAlert;
};

export type EmailSendRequest = {
  deliveryId: string;
  incidentEventId: string;
  alertType: AlertType;
  channel: "email";
  content: RenderedEmailAlert;
};

export type AlertDeliveryMessage = TelegramSendRequest | EmailSendRequest;

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
      const rendered = await renderAlertDeliveryMessage(delivery);
      if ("configurationError" in rendered) {
        const marked = await markAlertDeliveryConfigurationFailed({
          deliveryId: delivery.id,
          workerId: input.workerId,
          claimedAttemptCount: delivery.attemptCount,
          errorCode: rendered.configurationError
        });
        if (marked?.status === "failed") result.failed += 1;
        continue;
      }

      const sent = await input.sender.send(rendered);
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

async function renderAlertDeliveryMessage(
  delivery: Awaited<ReturnType<typeof claimDueAlertDeliveries>>[number]
): Promise<
  | AlertDeliveryMessage
  | { configurationError: AlertDeliveryConfigurationErrorCode }
> {
  const common = {
    deliveryId: delivery.id,
    incidentEventId: delivery.incidentEventId,
    alertType: delivery.alertType
  };

  if (delivery.channel === "telegram") {
    const destination = await getTelegramDestination(delivery.storeId);
    if (!destination) {
      return { configurationError: "telegram_destination_missing" };
    }
    if (!destination.enabled) {
      return { configurationError: "telegram_destination_disabled" };
    }
    return {
      ...common,
      channel: "telegram",
      destination: {
        chatId: destination.chatId,
        threadId: destination.threadId
      },
      content: renderTelegramAlert(delivery.payload)
    };
  }

  return {
    ...common,
    channel: "email",
    content: renderEmailAlert(delivery.payload)
  };
}
