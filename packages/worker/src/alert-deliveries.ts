import {
  claimDueAlertDeliveries,
  getEmailDestination,
  getTelegramDestination,
  markAlertDeliveryAttemptFailed,
  markAlertDeliveryPermanentFailed,
  markAlertDeliverySent,
  type AlertDeliveryConfigurationErrorCode,
  type AlertDeliveryChannel,
  type ClaimedAlertDelivery
} from "@eim/db";
import {
  renderEmailAlert,
  renderTelegramAlert,
  type AlertType,
  type RenderedEmailAlert,
  type RenderedTelegramAlert
} from "@eim/core";
import {
  isPermanentTelegramTransportError,
  TelegramTransportError
} from "./telegram-transport";
import {
  isPermanentResendTransportError,
  ResendTransportError
} from "./resend-email-transport";

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
  destination: {
    recipientEmails: string[];
  };
  content: RenderedEmailAlert;
};

export type AlertDeliveryMessage = TelegramSendRequest | EmailSendRequest;

export type AlertDeliverySender<
  Message extends AlertDeliveryMessage = AlertDeliveryMessage
> = {
  send(message: Message): Promise<{ providerMessageId: string }>;
};

type RunAlertDeliveryBatchBaseInput = {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
};

export type RunAlertDeliveryBatchInput = RunAlertDeliveryBatchBaseInput &
  (
    | {
        channel: "telegram";
        sender: AlertDeliverySender<TelegramSendRequest>;
      }
    | {
        channel: "email";
        sender: AlertDeliverySender<EmailSendRequest>;
      }
  );

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
      if (delivery.payloadStatus !== "valid") {
        const marked = await markAlertDeliveryPermanentFailed({
          deliveryId: delivery.id,
          workerId: input.workerId,
          claimedAttemptCount: delivery.attemptCount,
          errorCode: delivery.payloadStatus
        });
        if (marked?.status === "failed") result.failed += 1;
        continue;
      }

      const rendered = await renderAlertDeliveryMessage(delivery);
      if ("configurationError" in rendered) {
        const marked = await markAlertDeliveryPermanentFailed({
          deliveryId: delivery.id,
          workerId: input.workerId,
          claimedAttemptCount: delivery.attemptCount,
          errorCode: rendered.configurationError
        });
        if (marked?.status === "failed") result.failed += 1;
        continue;
      }

      const sent = await sendRenderedMessage(input, rendered);
      const marked = await markAlertDeliverySent({
        deliveryId: delivery.id,
        workerId: input.workerId,
        claimedAttemptCount: delivery.attemptCount,
        providerMessageId: sent.providerMessageId
      });
      if (marked?.status === "sent") result.sent += 1;
    } catch (error) {
      if (
        input.channel === "telegram" &&
        isPermanentTelegramTransportError(error)
      ) {
        const marked = await markAlertDeliveryPermanentFailed({
          deliveryId: delivery.id,
          workerId: input.workerId,
          claimedAttemptCount: delivery.attemptCount,
          errorCode: error.code,
          safeDescription: error.providerDescription
        });
        if (marked?.status === "failed") result.failed += 1;
        continue;
      }
      if (input.channel === "email" && isPermanentResendTransportError(error)) {
        const marked = await markAlertDeliveryPermanentFailed({
          deliveryId: delivery.id,
          workerId: input.workerId,
          claimedAttemptCount: delivery.attemptCount,
          errorCode: error.code,
          safeDescription: error.safeDescription
        });
        if (marked?.status === "failed") result.failed += 1;
        continue;
      }

      const marked = await markAlertDeliveryAttemptFailed({
        deliveryId: delivery.id,
        workerId: input.workerId,
        claimedAttemptCount: delivery.attemptCount,
        error,
        maxAttempts: input.maxAttempts,
        retryAfterSeconds:
          error instanceof TelegramTransportError || error instanceof ResendTransportError
            ? error.retryAfterSeconds
            : undefined
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

async function sendRenderedMessage(
  input: RunAlertDeliveryBatchInput,
  rendered: AlertDeliveryMessage
): Promise<{ providerMessageId: string }> {
  if (input.channel === "telegram" && rendered.channel === "telegram") {
    return input.sender.send(rendered);
  }
  if (input.channel === "email" && rendered.channel === "email") {
    return input.sender.send(rendered);
  }
  throw new Error("Claimed alert delivery channel did not match the worker channel");
}

async function renderAlertDeliveryMessage(
  delivery: Extract<ClaimedAlertDelivery, { payloadStatus: "valid" }>
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

  const destination = await getEmailDestination(delivery.storeId);
  if (!destination) {
    return { configurationError: "email_destination_missing" };
  }
  if (!destination.enabled) {
    return { configurationError: "email_destination_disabled" };
  }

  return {
    ...common,
    channel: "email",
    destination: {
      recipientEmails: destination.recipientEmails
    },
    content: renderEmailAlert(delivery.payload)
  };
}
