import pool from '../config/database';
import {
  NombaTokenResponse,
  NombaVirtualAccountResponse,
  NombaTransferResponse,
  NombaBankResolveResponse,
} from '../types';

// ─── Environment Configuration ───────────────────────────────────────────
// Nomba has TWO separate environments:
//   SANDBOX: Test credentials: sandbox.nomba.com (for testing)
//   PRODUCTION: Live credentials: api.nomba.com (for live transactions)
//
// IMPORTANT: Test credentials will NOT work on production URLs
//            Live credentials will NOT work on sandbox URLs

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const NOMBA_AUTH_URL = 'https://api.nomba.com';
const NOMBA_BASE_URL = IS_PRODUCTION
  ? 'https://api.nomba.com' // Production endpoint
  : process.env.NOMBA_BASE_URL || 'https://sandbox.nomba.com'; // Sandbox endpoint

const CLIENT_ID = process.env.NOMBA_CLIENT_ID!;
const CLIENT_SECRET = process.env.NOMBA_CLIENT_SECRET!;
const PARENT_ACCOUNT_ID = process.env.NOMBA_PARENT_ACCOUNT_ID!;
const SUB_ACCOUNT_ID = process.env.NOMBA_SUB_ACCOUNT_ID!;

// ─── Token Management ─────────────────────────────────────────────────────────

async function getCachedToken(): Promise<string | null> {
  const result = await pool.query(
    `SELECT access_token, expires_at FROM nomba_token_cache
     WHERE expires_at > NOW() + INTERVAL '5 minutes'
     ORDER BY created_at DESC LIMIT 1`
  );
  return result.rows[0]?.access_token ?? null;
}

async function cacheToken(accessToken: string, refreshToken: string, expiresAt: string): Promise<void> {
  await pool.query('DELETE FROM nomba_token_cache');
  await pool.query(
    `INSERT INTO nomba_token_cache (access_token, refresh_token, expires_at)
     VALUES ($1, $2, $3)`,
    [accessToken, refreshToken, new Date(expiresAt)]
  );
}

async function fetchNewToken(): Promise<string> {
  const response = await fetch(`${NOMBA_AUTH_URL}/v1/auth/token/issue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'accountId': PARENT_ACCOUNT_ID,
    },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Nomba auth failed: ${error}`);
  }

  const data = (await response.json()) as NombaTokenResponse;

  if (data.code !== '00') {
    throw new Error(`Nomba auth error: ${data.description}`);
  }

  return data.data.access_token;
}

export async function getNombaToken(): Promise<string> {
  return fetchNewToken();
}

// ─── Base request helper ──────────────────────────────────────────────────────

async function nombaRequest<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  useSubAccount = false
): Promise<T> {
  const token = await getNombaToken();
  const accountId = useSubAccount ? SUB_ACCOUNT_ID : PARENT_ACCOUNT_ID;

  console.log("NOMBA URL:", `${NOMBA_BASE_URL}${path}`);
  console.log("NOMBA METHOD:", method);
  console.log("NOMBA BODY:", body);
  console.log("NOMBA ACCOUNT ID:", accountId);

  const response = await fetch(`${NOMBA_BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'accountId': accountId,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = (await response.json()) as T & { code: string; description: string };

  if (!response.ok || data.code !== '00') {
    console.error("========== NOMBA ERROR ==========");
    console.error("STATUS:", response.status);
    console.error("REQUEST BODY:", body);
    console.error("RESPONSE:", JSON.stringify(data, null, 2));
    console.error("=================================");
    throw new Error(`Nomba API error [${path}]: ${data.description || response.statusText}`);
  }

  return data;
}

// ─── Virtual Accounts ─────────────────────────────────────────────────────────

export async function createVirtualAccount(params: {
    accountRef: string;
    accountName: string;
    currency: string;
    bvn?: string;
    expectedAmount?: number;
}): Promise<NombaVirtualAccountResponse['data']> {
  console.log("CREATE VIRTUAL ACCOUNT REQUEST BODY:", JSON.stringify({
      accountRef: params.accountRef,
      accountName: params.accountName,
      currency: params.currency,
      bvn: params.bvn,
      expectedAmount: params.expectedAmount,
  }, null, 2));

  const data = await nombaRequest<NombaVirtualAccountResponse>(
        'POST',
        '/v1/accounts/virtual',
        {
            accountRef: params.accountRef,
            accountName: params.accountName,
            currency: params.currency,
            ...(params.bvn && { bvn: params.bvn }),
            ...(params.expectedAmount !== undefined && {
                expectedAmount: params.expectedAmount
            }),
        }
    );

    console.log(
        'RAW NOMBA VIRTUAL ACCOUNT RESPONSE:',
        JSON.stringify(data, null, 2)
    );

    return data.data;
}
// ─── Transfers ────────────────────────────────────────────────────────────────

export async function fetchBanks(): Promise<Array<{ code: string; name: string }>> {
  const data = await nombaRequest<{ code: string; data: { results: Array<{ code: string; name: string }> } }>(
    'GET',
    '/v1/transfers/banks'
  );
  return data.data.results;
}

export async function initiateTransfer(params: {
  amount: number;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  narration: string;
  idempotencyKey: string;
}): Promise<NombaTransferResponse['data']> {
  const data = await nombaRequest<NombaTransferResponse>(
    'POST',
    '/v2/transfers/bank',
    {
      amount: params.amount,
      accountNumber: params.accountNumber,
      accountName: params.accountName,
      bankCode: params.bankCode,
      merchantTxRef: params.idempotencyKey,
      senderName: params.accountName,
      narration: params.narration,
    }
  );
  return data.data;
}

// ─── Bank Account Resolution ──────────────────────────────────────────────────

export async function resolveBankAccount(params: {
    accountNumber: string;
    bankCode: string;
}): Promise<NombaBankResolveResponse['data']> {
    const data = await nombaRequest<NombaBankResolveResponse>(
        'POST',
        '/v1/transfers/bank/lookup',
        {
            accountNumber: params.accountNumber,
            bankCode: params.bankCode,
        }
    );

    return data.data;
}
// ─── Fetch Virtual Account Transactions ──────────────────────────────────────

export async function fetchVirtualAccountTransactions(accountRef: string): Promise<unknown[]> {
  const data = await nombaRequest<{ code: string; data: { results: unknown[] } }>(
    'GET',
    `/v1/accounts/virtual/${accountRef}/transactions`
  );
  return data.data.results;
}
