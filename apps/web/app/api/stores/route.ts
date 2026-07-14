import { createStoreInputSchema } from "@eim/core";
import { createStore, DuplicateStoreDomainError, listStores } from "@eim/db";
import { enqueueSnapshotJob } from "@eim/worker";
import { NextResponse } from "next/server";

export async function GET() {
  const stores = await listStores();
  return NextResponse.json({ stores });
}

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = createStoreInputSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid store payload",
        issues: parsed.error.flatten()
      },
      { status: 400 }
    );
  }

  let result;

  try {
    result = await createStore(parsed.data);
  } catch (error) {
    if (error instanceof DuplicateStoreDomainError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  await enqueueSnapshotJob({
    snapshotId: result.snapshotId,
    storeId: result.store.id,
    reason: "store_created"
  });

  return NextResponse.json(result, { status: 201 });
}
