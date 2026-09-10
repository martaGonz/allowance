import { describe, it, expect, vi, afterEach } from 'vitest';
import { payAndRetry } from './pay.js';

describe('payAndRetry', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('si la primera respuesta no es 402, la devuelve tal cual y no toca el SDK de Hedera', async () => {
    // Sin HEDERA_ACCOUNT_ID/HEDERA_PRIVATE_KEY en el entorno: si esta rama tocara el
    // SDK de pago, fallaría por credenciales ausentes. No falla porque no lo toca.
    globalThis.fetch = vi.fn(async () => new Response('ya pagado antes', { status: 200 })) as unknown as typeof fetch;

    const result = await payAndRetry('http://localhost:8402/tools/token_price?contract=0xa', 2_000);

    expect(result).toEqual({ status: 200, body: 'ya pagado antes', txId: null });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('sin credenciales configuradas, una respuesta 402 real hace fallar el pago en vez de simularlo', async () => {
    delete process.env.HEDERA_ACCOUNT_ID;
    delete process.env.HEDERA_PRIVATE_KEY;
    globalThis.fetch = vi.fn(async () => new Response('pago requerido', { status: 402 })) as unknown as typeof fetch;

    await expect(payAndRetry('http://localhost:8402/tools/token_price?contract=0xa', 2_000)).rejects.toThrow(
      /HEDERA_ACCOUNT_ID/,
    );
  });
});
