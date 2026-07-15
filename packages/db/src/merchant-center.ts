import {
  merchantCenterConnectionInputSchema,
  type MerchantCenterConnectionInput
} from "@eim/core";
import type pg from "pg";
import { getPool } from "./client";

type MerchantCenterConnectionRow = {
  id: string;
  merchant_center_account_id: string | null;
};

export type MerchantCenterConnectionRecord = {
  storeId: string;
  merchantCenterAccountId: string | null;
  connected: boolean;
};

export class MerchantCenterStoreNotFoundError extends Error {
  constructor(storeId: string) {
    super(`Store ${storeId} was not found`);
    this.name = "MerchantCenterStoreNotFoundError";
  }
}

export async function getMerchantCenterConnection(
  storeId: string,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<MerchantCenterConnectionRecord | null> {
  const result = await executor.query<MerchantCenterConnectionRow>(
    "SELECT id, merchant_center_account_id FROM stores WHERE id = $1",
    [storeId]
  );
  const row = result.rows[0];

  return row ? mapMerchantCenterConnection(row) : null;
}

export async function connectMerchantCenter(
  storeId: string,
  input: MerchantCenterConnectionInput,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<MerchantCenterConnectionRecord> {
  const connection = merchantCenterConnectionInputSchema.parse(input);
  const result = await executor.query<MerchantCenterConnectionRow>(
    `
      UPDATE stores
      SET merchant_center_account_id = $2
      WHERE id = $1
      RETURNING id, merchant_center_account_id
    `,
    [storeId, connection.merchantCenterAccountId]
  );
  const row = result.rows[0];

  if (!row) {
    throw new MerchantCenterStoreNotFoundError(storeId);
  }

  return mapMerchantCenterConnection(row);
}

export async function disconnectMerchantCenter(
  storeId: string,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<MerchantCenterConnectionRecord> {
  const result = await executor.query<MerchantCenterConnectionRow>(
    `
      UPDATE stores
      SET merchant_center_account_id = NULL
      WHERE id = $1
      RETURNING id, merchant_center_account_id
    `,
    [storeId]
  );
  const row = result.rows[0];

  if (!row) {
    throw new MerchantCenterStoreNotFoundError(storeId);
  }

  return mapMerchantCenterConnection(row);
}

function mapMerchantCenterConnection(
  row: MerchantCenterConnectionRow
): MerchantCenterConnectionRecord {
  return {
    storeId: row.id,
    merchantCenterAccountId: row.merchant_center_account_id,
    connected: row.merchant_center_account_id !== null
  };
}
