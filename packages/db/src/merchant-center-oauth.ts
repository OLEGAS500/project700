import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { getPool, withTransaction } from "./client";
import { MerchantCenterStoreNotFoundError } from "./merchant-center";

const cipherAlgorithm = "aes-256-gcm";
const cipherVersion = "v1";
const stateHashPattern = /^[a-f0-9]{64}$/;

type OAuthStateRow = {
  store_id: string;
  redirect_uri: string;
  expires_at: Date;
};

type CredentialRow = {
  store_id: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string;
  token_type: string;
  expires_at: Date;
  scopes: string[];
  metadata_json: unknown;
  credentials_version: number;
  refresh_lock_id: string | null;
  refresh_lock_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type CreateMerchantCenterOAuthStateInput = {
  stateHash: string;
  redirectUri: string;
  expiresAt: Date;
};

export type MerchantCenterOAuthStateRecord = {
  storeId: string;
  redirectUri: string;
  expiresAt: string;
};

export type UpsertMerchantCenterOAuthCredentialsInput = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: Date;
  scopes: string[];
  metadata: Record<string, string>;
};

export type MerchantCenterOAuthCredentialRecord = {
  storeId: string;
  hasAccessToken: true;
  hasRefreshToken: true;
  tokenType: string;
  expiresAt: string;
  scopes: string[];
  metadata: Record<string, string>;
  credentialsVersion: number;
  refreshInProgress: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MerchantCenterOAuthStatusRecord = {
  storeId: string;
  credentials: MerchantCenterOAuthCredentialRecord | null;
};

export type MerchantCenterOAuthTokenSet = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: Date;
  scopes: string[];
  metadata: Record<string, string>;
};

export class MerchantCenterOAuthStateInvalidError extends Error {
  constructor() {
    super("Merchant Center OAuth state is invalid or expired");
    this.name = "MerchantCenterOAuthStateInvalidError";
  }
}

export class MerchantCenterOAuthCredentialsNotFoundError extends Error {
  constructor(storeId: string) {
    super(`Merchant Center OAuth credentials for store ${storeId} were not found`);
    this.name = "MerchantCenterOAuthCredentialsNotFoundError";
  }
}

export class MerchantCenterOAuthRefreshInProgressError extends Error {
  constructor() {
    super("Merchant Center OAuth credentials are already being refreshed");
    this.name = "MerchantCenterOAuthRefreshInProgressError";
  }
}

export class MerchantCenterOAuthCredentialLeaseLostError extends Error {
  constructor() {
    super("Merchant Center OAuth credential refresh lease was lost");
    this.name = "MerchantCenterOAuthCredentialLeaseLostError";
  }
}

export class MerchantCenterCredentialEncryptionConfigurationError extends Error {
  constructor() {
    super("Merchant Center credential encryption is not configured");
    this.name = "MerchantCenterCredentialEncryptionConfigurationError";
  }
}

export class MerchantCenterCredentialDecryptionError extends Error {
  constructor() {
    super("Merchant Center credential decryption failed");
    this.name = "MerchantCenterCredentialDecryptionError";
  }
}

export async function createMerchantCenterOAuthState(
  storeId: string,
  input: CreateMerchantCenterOAuthStateInput,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<void> {
  if (!stateHashPattern.test(input.stateHash)) {
    throw new Error("Invalid Merchant Center OAuth state hash");
  }

  const result = await executor.query(
    `
      INSERT INTO merchant_center_oauth_states (
        store_id,
        state_hash,
        redirect_uri,
        expires_at
      )
      SELECT $1, $2, $3, $4
      FROM stores
      WHERE id = $1
    `,
    [storeId, input.stateHash, input.redirectUri, input.expiresAt]
  );

  if (result.rowCount !== 1) {
    throw new MerchantCenterStoreNotFoundError(storeId);
  }
}

export async function consumeMerchantCenterOAuthState(
  stateHash: string,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<MerchantCenterOAuthStateRecord> {
  const result = await executor.query<OAuthStateRow>(
    `
      UPDATE merchant_center_oauth_states
      SET consumed_at = clock_timestamp()
      WHERE state_hash = $1
        AND consumed_at IS NULL
        AND expires_at > clock_timestamp()
      RETURNING store_id, redirect_uri, expires_at
    `,
    [stateHash]
  );
  const row = result.rows[0];

  if (!row) {
    throw new MerchantCenterOAuthStateInvalidError();
  }

  return {
    storeId: row.store_id,
    redirectUri: row.redirect_uri,
    expiresAt: row.expires_at.toISOString()
  };
}

export async function getMerchantCenterOAuthCredentials(
  storeId: string,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<MerchantCenterOAuthCredentialRecord | null> {
  const result = await executor.query<CredentialRow>(
    "SELECT * FROM merchant_center_oauth_credentials WHERE store_id = $1",
    [storeId]
  );
  const row = result.rows[0];

  return row ? mapCredentialRecord(row) : null;
}

export async function getMerchantCenterOAuthStatus(
  storeId: string,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<MerchantCenterOAuthStatusRecord | null> {
  const result = await executor.query<CredentialRow>(
    `
      SELECT credentials.*
      FROM stores
      LEFT JOIN merchant_center_oauth_credentials AS credentials
        ON credentials.store_id = stores.id
      WHERE stores.id = $1
    `,
    [storeId]
  );
  const row = result.rows[0];

  if (!row) return null;
  return {
    storeId,
    credentials: row.encrypted_access_token ? mapCredentialRecord(row) : null
  };
}

export async function upsertMerchantCenterOAuthCredentials(
  storeId: string,
  input: UpsertMerchantCenterOAuthCredentialsInput,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<MerchantCenterOAuthCredentialRecord> {
  return upsertMerchantCenterOAuthCredentialsWithExecutor(storeId, input, executor);
}

export async function completeMerchantCenterOAuthAuthorization(
  stateHash: string,
  input: UpsertMerchantCenterOAuthCredentialsInput
): Promise<MerchantCenterOAuthCredentialRecord> {
  return withTransaction(async (client) => {
    const state = await client.query<{ store_id: string }>(
      `
        SELECT store_id
        FROM merchant_center_oauth_states
        WHERE state_hash = $1 AND consumed_at IS NOT NULL
        FOR UPDATE
      `,
      [stateHash]
    );

    const stateRow = state.rows[0];
    if (!stateRow) {
      throw new MerchantCenterOAuthStateInvalidError();
    }

    const credentials = await upsertMerchantCenterOAuthCredentialsWithExecutor(
      stateRow.store_id,
      input,
      client
    );
    await client.query("DELETE FROM merchant_center_oauth_states WHERE state_hash = $1", [stateHash]);
    return credentials;
  });
}

async function upsertMerchantCenterOAuthCredentialsWithExecutor(
  storeId: string,
  input: UpsertMerchantCenterOAuthCredentialsInput,
  executor: pg.Pool | pg.PoolClient
): Promise<MerchantCenterOAuthCredentialRecord> {
  const encryptedAccessToken = encryptSecret(input.accessToken);
  const encryptedRefreshToken = encryptSecret(input.refreshToken);
  const result = await executor.query<CredentialRow>(
    `
      INSERT INTO merchant_center_oauth_credentials (
        store_id,
        encrypted_access_token,
        encrypted_refresh_token,
        token_type,
        expires_at,
        scopes,
        metadata_json
      )
      SELECT $1, $2, $3, $4, $5, $6, $7::jsonb
      FROM stores
      WHERE id = $1
      ON CONFLICT (store_id)
      DO UPDATE SET
        encrypted_access_token = EXCLUDED.encrypted_access_token,
        encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
        token_type = EXCLUDED.token_type,
        expires_at = EXCLUDED.expires_at,
        scopes = EXCLUDED.scopes,
        metadata_json = EXCLUDED.metadata_json,
        credentials_version = merchant_center_oauth_credentials.credentials_version + 1,
        refresh_lock_id = NULL,
        refresh_lock_expires_at = NULL,
        updated_at = clock_timestamp()
      RETURNING *
    `,
    [
      storeId,
      encryptedAccessToken,
      encryptedRefreshToken,
      input.tokenType,
      input.expiresAt,
      input.scopes,
      JSON.stringify(input.metadata)
    ]
  );
  const row = result.rows[0];

  if (!row) {
    throw new MerchantCenterStoreNotFoundError(storeId);
  }

  return mapCredentialRecord(row);
}

export async function getMerchantCenterOAuthTokenSet(
  storeId: string,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<MerchantCenterOAuthTokenSet> {
  const result = await executor.query<CredentialRow>(
    "SELECT * FROM merchant_center_oauth_credentials WHERE store_id = $1",
    [storeId]
  );
  const row = result.rows[0];

  if (!row) {
    throw new MerchantCenterOAuthCredentialsNotFoundError(storeId);
  }

  return {
    accessToken: decryptSecret(row.encrypted_access_token),
    refreshToken: decryptSecret(row.encrypted_refresh_token),
    tokenType: row.token_type,
    expiresAt: row.expires_at,
    scopes: row.scopes,
    metadata: parseMetadata(row.metadata_json)
  };
}

export async function claimMerchantCenterOAuthRefresh(
  storeId: string,
  lockId: string,
  leaseSeconds = 60,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<MerchantCenterOAuthTokenSet> {
  const result = await executor.query<CredentialRow>(
    `
      UPDATE merchant_center_oauth_credentials
      SET refresh_lock_id = $2,
          refresh_lock_expires_at = clock_timestamp() + ($3::double precision * INTERVAL '1 second'),
          updated_at = clock_timestamp()
      WHERE store_id = $1
        AND (
          refresh_lock_id IS NULL
          OR refresh_lock_expires_at <= clock_timestamp()
        )
      RETURNING *
    `,
    [storeId, lockId, leaseSeconds]
  );
  const row = result.rows[0];

  if (row) {
    return {
      accessToken: decryptSecret(row.encrypted_access_token),
      refreshToken: decryptSecret(row.encrypted_refresh_token),
      tokenType: row.token_type,
      expiresAt: row.expires_at,
      scopes: row.scopes,
      metadata: parseMetadata(row.metadata_json)
    };
  }

  const existing = await executor.query<{ store_id: string }>(
    "SELECT store_id FROM merchant_center_oauth_credentials WHERE store_id = $1",
    [storeId]
  );
  if (!existing.rows[0]) {
    throw new MerchantCenterOAuthCredentialsNotFoundError(storeId);
  }

  throw new MerchantCenterOAuthRefreshInProgressError();
}

export async function completeMerchantCenterOAuthRefresh(
  storeId: string,
  lockId: string,
  input: UpsertMerchantCenterOAuthCredentialsInput,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<MerchantCenterOAuthCredentialRecord> {
  const result = await executor.query<CredentialRow>(
    `
      UPDATE merchant_center_oauth_credentials
      SET encrypted_access_token = $3,
          encrypted_refresh_token = $4,
          token_type = $5,
          expires_at = $6,
          scopes = $7,
          metadata_json = $8::jsonb,
          credentials_version = credentials_version + 1,
          refresh_lock_id = NULL,
          refresh_lock_expires_at = NULL,
          updated_at = clock_timestamp()
      WHERE store_id = $1
        AND refresh_lock_id = $2
      RETURNING *
    `,
    [
      storeId,
      lockId,
      encryptSecret(input.accessToken),
      encryptSecret(input.refreshToken),
      input.tokenType,
      input.expiresAt,
      input.scopes,
      JSON.stringify(input.metadata)
    ]
  );
  const row = result.rows[0];

  if (!row) {
    throw new MerchantCenterOAuthCredentialLeaseLostError();
  }

  return mapCredentialRecord(row);
}

export async function releaseMerchantCenterOAuthRefresh(
  storeId: string,
  lockId: string,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<void> {
  await executor.query(
    `
      UPDATE merchant_center_oauth_credentials
      SET refresh_lock_id = NULL,
          refresh_lock_expires_at = NULL,
          updated_at = clock_timestamp()
      WHERE store_id = $1 AND refresh_lock_id = $2
    `,
    [storeId, lockId]
  );
}

export async function deleteMerchantCenterOAuthCredentials(
  storeId: string,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<void> {
  await executor.query("DELETE FROM merchant_center_oauth_credentials WHERE store_id = $1", [storeId]);
}

function mapCredentialRecord(row: CredentialRow): MerchantCenterOAuthCredentialRecord {
  return {
    storeId: row.store_id,
    hasAccessToken: true,
    hasRefreshToken: true,
    tokenType: row.token_type,
    expiresAt: row.expires_at.toISOString(),
    scopes: row.scopes,
    metadata: parseMetadata(row.metadata_json),
    credentialsVersion: row.credentials_version,
    refreshInProgress: row.refresh_lock_id !== null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function parseMetadata(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(cipherAlgorithm, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    cipherVersion,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    encrypted.toString("base64url")
  ].join(":");
}

function decryptSecret(value: string): string {
  try {
    const [version, ivValue, authTagValue, encryptedValue] = value.split(":");
    if (version !== cipherVersion || !ivValue || !authTagValue || !encryptedValue) {
      throw new Error("invalid encrypted credential");
    }

    const decipher = createDecipheriv(
      cipherAlgorithm,
      getEncryptionKey(),
      Buffer.from(ivValue, "base64url")
    );
    decipher.setAuthTag(Buffer.from(authTagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    throw new MerchantCenterCredentialDecryptionError();
  }
}

function getEncryptionKey(): Buffer {
  const encoded = process.env.MERCHANT_CENTER_CREDENTIALS_ENCRYPTION_KEY?.trim();
  if (!encoded) {
    throw new MerchantCenterCredentialEncryptionConfigurationError();
  }

  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new MerchantCenterCredentialEncryptionConfigurationError();
  }

  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hashMerchantCenterOAuthState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}
