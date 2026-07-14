import { afterEach, describe, expect, it } from "vitest";
import {
  clearQueuedSnapshotJobs,
  enqueueSnapshotJob,
  getQueuedSnapshotJobs
} from "./snapshots";

describe("snapshot queue placeholder", () => {
  afterEach(() => {
    clearQueuedSnapshotJobs();
  });

  it("queues the first snapshot after store creation", async () => {
    const queued = await enqueueSnapshotJob({
      snapshotId: "a3a14034-2165-4906-bdf6-9aad72e1d185",
      storeId: "0f53ad25-9008-41df-9e6e-c4a0bb69d95d",
      reason: "store_created"
    });

    expect(queued.status).toBe("queued");
    expect(queued.baselineRole).toBe("candidate");
    expect(getQueuedSnapshotJobs()).toHaveLength(1);
  });

  it("deduplicates jobs in the same store role and minute window", async () => {
    const job = {
      snapshotId: "a3a14034-2165-4906-bdf6-9aad72e1d185",
      storeId: "0f53ad25-9008-41df-9e6e-c4a0bb69d95d",
      reason: "store_created" as const,
      scheduledFor: "2026-07-14T11:15:37.000Z"
    };

    await enqueueSnapshotJob(job);
    await enqueueSnapshotJob({
      ...job,
      snapshotId: "d90efc4f-73e1-4865-b0e9-f31b0bb8d704"
    });

    expect(getQueuedSnapshotJobs()).toHaveLength(1);
    expect(getQueuedSnapshotJobs()[0].scheduledFor).toBe("2026-07-14T11:15:00.000Z");
  });
});
