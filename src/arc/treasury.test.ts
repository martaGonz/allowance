import { describe, it, expect, afterEach } from 'vitest';
import type { CreateTransferTransactionInput } from '@circle-fin/developer-controlled-wallets';
import { arcChain, settle, liveSettleDeps, type SettleDeps } from './treasury.js';

const WALLET_ID = 'a635d679-4207-4e37-b12e-766afb9b3892';
const TO = '0xa51c9c604b79a0fadbfed35dd576ca1bce71da0a';

/**
 * Cliente falso que solo registra la última entrada de `createTransaction`.
 * `settle` únicamente necesita `createTransaction` (SettleDeps la acota con
 * `Pick`), así que el falso no implementa el resto del cliente real de
 * Circle.
 */
function fakeClient(): { client: SettleDeps['client']; calls: CreateTransferTransactionInput[] } {
  const calls: CreateTransferTransactionInput[] = [];
  return {
    calls,
    client: {
      createTransaction: async (input: CreateTransferTransactionInput) => {
        calls.push(input);
        return { data: { id: 'circle-tx-1', state: 'INITIATED' } } as Awaited<
          ReturnType<SettleDeps['client']['createTransaction']>
        >;
      },
    },
  };
}

describe('tesorería en Arc', () => {
  it('apunta a la testnet correcta por defecto', () => {
    expect(arcChain.id).toBe(5042002);
    expect(arcChain.rpcUrls.default.http[0]).toBe('https://rpc.testnet.arc.network');
    expect(arcChain.nativeCurrency.decimals).toBe(18);
  });

  it('settle llama a createTransaction con el importe en decimal, el token nativo vacío y el walletId', async () => {
    const { client, calls } = fakeClient();
    const deps: SettleDeps = { client, walletId: WALLET_ID };

    const txId = await settle(deps, 2_000, TO, 'ref-1');

    expect(txId).toBe('circle-tx-1');
    expect(calls).toHaveLength(1);
    const input = calls[0]!;
    expect(input.amount).toEqual(['0.002']);
    expect(input.tokenAddress).toBe('');
    expect(input.destinationAddress).toBe(TO);
    expect(input.walletId).toBe(WALLET_ID);
    expect(input.fee).toEqual({ type: 'level', config: { feeLevel: 'MEDIUM' } });
  });

  it('la misma ref produce siempre el mismo idempotencyKey', async () => {
    const { client, calls } = fakeClient();
    const deps: SettleDeps = { client, walletId: WALLET_ID };

    await settle(deps, 2_000, TO, 'pago-mismo-ref');
    await settle(deps, 2_000, TO, 'pago-mismo-ref');

    expect(calls).toHaveLength(2);
    expect(calls[0]!.idempotencyKey).toBeTruthy();
    expect(calls[0]!.idempotencyKey).toBe(calls[1]!.idempotencyKey);
  });

  it('una ref distinta produce un idempotencyKey distinto', async () => {
    const { client, calls } = fakeClient();
    const deps: SettleDeps = { client, walletId: WALLET_ID };

    await settle(deps, 2_000, TO, 'ref-a');
    await settle(deps, 2_000, TO, 'ref-b');

    expect(calls[0]!.idempotencyKey).not.toBe(calls[1]!.idempotencyKey);
  });

  it('el idempotencyKey tiene forma de UUID v4', async () => {
    const { client, calls } = fakeClient();
    const deps: SettleDeps = { client, walletId: WALLET_ID };

    await settle(deps, 2_000, TO, 'cualquier-ref');

    expect(calls[0]!.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('liveSettleDeps', () => {
  const originalApiKey = process.env.CIRCLE_API_KEY;
  const originalEntitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const originalWalletId = process.env.CIRCLE_WALLET_ID;

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.CIRCLE_API_KEY;
    else process.env.CIRCLE_API_KEY = originalApiKey;
    if (originalEntitySecret === undefined) delete process.env.CIRCLE_ENTITY_SECRET;
    else process.env.CIRCLE_ENTITY_SECRET = originalEntitySecret;
    if (originalWalletId === undefined) delete process.env.CIRCLE_WALLET_ID;
    else process.env.CIRCLE_WALLET_ID = originalWalletId;
  });

  it('lanza si falta CIRCLE_API_KEY', () => {
    delete process.env.CIRCLE_API_KEY;
    process.env.CIRCLE_ENTITY_SECRET = 'secreto';
    process.env.CIRCLE_WALLET_ID = WALLET_ID;

    expect(() => liveSettleDeps()).toThrow(/CIRCLE_API_KEY/);
  });

  it('lanza si falta CIRCLE_ENTITY_SECRET', () => {
    process.env.CIRCLE_API_KEY = 'clave';
    delete process.env.CIRCLE_ENTITY_SECRET;
    process.env.CIRCLE_WALLET_ID = WALLET_ID;

    expect(() => liveSettleDeps()).toThrow(/CIRCLE_ENTITY_SECRET/);
  });

  it('lanza si falta CIRCLE_WALLET_ID', () => {
    process.env.CIRCLE_API_KEY = 'clave';
    process.env.CIRCLE_ENTITY_SECRET = 'secreto';
    delete process.env.CIRCLE_WALLET_ID;

    expect(() => liveSettleDeps()).toThrow(/CIRCLE_WALLET_ID/);
  });
});
