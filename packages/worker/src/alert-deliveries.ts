import {
  claimDueAlertDeliveries,
  markAlertDeliveryAttemptFailed,
  markAlertDeliverySent,
  type AlertDeliveryChannel,
  type ClaimedAlertDelivery
} from "@eim/db";

export type AlertDeliverySender = {
  send(delivery: ClaimedAlertDelivery): Promise<{ providerMessageId: string }>;
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
      const sent = await input.sender.send(delivery);
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
