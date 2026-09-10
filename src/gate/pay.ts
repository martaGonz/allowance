import { x402Client, x402HTTPClient } from '@x402/core/client';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { createClientHederaSigner, PrivateKey } from '@x402/hedera';
import { HEDERA_TESTNET_NETWORK, HEDERA_TESTNET_USDC } from './routes.js';

export type PayAndRetryResult = { status: number; body: string; txId: string | null };

/**
 * Paga una llamada a la puerta x402 y reintenta. Nunca simula un pago: la
 * primera respuesta 402 real se resuelve con el envoltorio de fetch del
 * cliente x402 (`x402HTTPClient`) sobre `createClientHederaSigner`, que
 * firma y envía una transferencia real de USDC (token 0.0.429274) en
 * Hedera testnet. Las credenciales se leen dentro de la función: nada del
 * SDK se construye al cargar el módulo.
 */
export async function payAndRetry(url: string, priceMicroUsdc: number): Promise<PayAndRetryResult> {
  const first = await fetch(url);
  if (first.status !== 402) {
    return { status: first.status, body: await first.text(), txId: null };
  }

  const accountId = process.env.HEDERA_ACCOUNT_ID;
  const privateKeyHex = process.env.HEDERA_PRIVATE_KEY;
  if (!accountId || !privateKeyHex) {
    throw new Error('HEDERA_ACCOUNT_ID/HEDERA_PRIVATE_KEY no configuradas: no se puede pagar de verdad');
  }

  const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(privateKeyHex), {
    network: HEDERA_TESTNET_NETWORK,
  });
  const client = new x402Client().register('hedera:*', new ExactHederaScheme(signer));
  const httpClient = new x402HTTPClient(client);

  const paymentRequired = httpClient.getPaymentRequiredResponse((name) => first.headers.get(name));

  // Nunca pagar más de lo que la nota de gasto ya autorizó para esta llamada.
  const quoted = paymentRequired.accepts.find(
    (accept) => accept.network === HEDERA_TESTNET_NETWORK && accept.asset === HEDERA_TESTNET_USDC,
  );
  if (!quoted || Number(quoted.amount) !== priceMicroUsdc) {
    throw new Error(
      `la puerta pide ${quoted?.amount ?? 'un importe desconocido'} microUSDC pero se autorizaron ${priceMicroUsdc}`,
    );
  }

  // x402Client.createPaymentPayload firma por defecto accepts[0] (selector por defecto de
  // @x402/core, dist/esm/client/index.mjs:39,441), no la entrada ya validada arriba. Si la
  // puerta anunciara varias opciones, comprobar `quoted` y firmar `paymentRequired` tal cual
  // dejaría que se firmase una entrada distinta de la comprobada. Se restringe `accepts` a
  // exactamente `quoted` para que sea imposible seleccionar y firmar otra cosa.
  const paymentPayload = await httpClient.createPaymentPayload({ ...paymentRequired, accepts: [quoted] });

  // Defensa en profundidad: el payload producido tiene que llevar exactamente lo comprobado.
  const accepted = paymentPayload.accepted;
  if (
    accepted.amount !== String(priceMicroUsdc) ||
    accepted.asset !== HEDERA_TESTNET_USDC ||
    accepted.network !== HEDERA_TESTNET_NETWORK
  ) {
    throw new Error(
      `el pago construido (${accepted.amount} ${accepted.asset} en ${accepted.network}) no coincide con lo autorizado (${priceMicroUsdc} ${HEDERA_TESTNET_USDC} en ${HEDERA_TESTNET_NETWORK}): no se envía`,
    );
  }

  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  const paid = await fetch(url, { headers: paymentHeaders });
  const body = await paid.text();

  let txId: string | null = null;
  try {
    const settleResponse = httpClient.getPaymentSettleResponse((name) => paid.headers.get(name));
    txId = settleResponse.transaction || null;
  } catch {
    txId = null;
  }

  return { status: paid.status, body, txId };
}
