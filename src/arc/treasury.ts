import { createHash } from 'node:crypto';
import { createPublicClient, defineChain, http } from 'viem';
import {
  initiateDeveloperControlledWalletsClient,
  type CircleDeveloperControlledWalletsClient,
} from '@circle-fin/developer-controlled-wallets';
import { microUsdcToDecimal } from './amount.js';

const ARC_CHAIN_ID = Number(process.env.ARC_CHAIN_ID ?? '5042002');
const ARC_RPC_URL = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network';

// Arc mainnet no existe hoy: nada de esto tiene rama para mainnet.
export const arcChain = defineChain({
  id: ARC_CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
  blockExplorers: { default: { name: 'Arcscan', url: 'https://testnet.arcscan.app' } },
  testnet: true,
});

export type SettleDeps = {
  client: Pick<CircleDeveloperControlledWalletsClient, 'createTransaction'>;
  walletId: string;
  tokenId: string;
};

/**
 * UUID v4 derivado de forma determinista de `ref` (sha256(ref), con los
 * nibbles de versión y variante fijados). Reintentar `settle` con la misma
 * `ref` produce siempre el mismo `idempotencyKey`, así que Circle nunca
 * liquida dos veces el mismo pago; una `ref` distinta produce uno distinto.
 */
function idempotencyKeyFromRef(ref: string): string {
  const hex = createHash('sha256').update(ref).digest('hex').slice(0, 32).split('');
  hex[12] = '4'; // versión 4
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16); // variante RFC 4122 (10xx)
  const uuid = hex.join('');
  return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20, 32)}`;
}

/**
 * Liquida una consulta pagada en USDC nativo de Arc testnet desde la
 * Developer-Controlled Wallet de Circle identificada por `deps.walletId`.
 * `tokenId` es el identificador de Circle del USDC nativo de Arc testnet, leído de la
 * propia cartera (`getWalletTokenBalance`). Circle rechaza con "API parameter invalid"
 * la forma `walletId` + `tokenAddress: ''`; la forma `walletId` + `tokenId` se probó
 * con una transferencia real que llegó a COMPLETE en Arc testnet.
 */
export async function settle(deps: SettleDeps, amountMicroUsdc: number, to: string, ref: string): Promise<string> {
  const response = await deps.client.createTransaction({
    walletId: deps.walletId,
    tokenId: deps.tokenId,
    amount: [microUsdcToDecimal(amountMicroUsdc)],
    destinationAddress: to,
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    idempotencyKey: idempotencyKeyFromRef(ref),
  });
  const id = response.data?.id;
  if (!id) throw new Error('Circle no devolvió id de transacción para la liquidación');
  return id;
}

/**
 * Construye el `SettleDeps` real leyendo las credenciales de Circle dentro
 * de la función: nada del SDK se construye al cargar el módulo. Sin
 * fallback silencioso a viem — si falta cualquiera de las tres variables,
 * lanza en vez de liquidar con una cartera equivocada o no liquidar en
 * absoluto sin que se note.
 */
export function liveSettleDeps(): SettleDeps {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const walletId = process.env.CIRCLE_WALLET_ID;
  const tokenId = process.env.CIRCLE_USDC_TOKEN_ID;
  if (!apiKey) throw new Error('CIRCLE_API_KEY no configurada: no se puede liquidar en Arc de verdad');
  if (!entitySecret) throw new Error('CIRCLE_ENTITY_SECRET no configurada: no se puede liquidar en Arc de verdad');
  if (!walletId) throw new Error('CIRCLE_WALLET_ID no configurada: no se puede liquidar en Arc de verdad');
  if (!tokenId) throw new Error('CIRCLE_USDC_TOKEN_ID no configurada: no se puede liquidar en Arc de verdad');
  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  return { client, walletId, tokenId };
}

/**
 * Saldo de la tesorería en Arc testnet, leído por RPC con viem
 * (`getBalance`) y truncado de los 18 decimales nativos a los 6 enteros de
 * la contabilidad con división en `bigint`, nunca con coma flotante.
 */
export async function treasuryBalanceMicroUsdc(address: string): Promise<number> {
  const publicClient = createPublicClient({ chain: arcChain, transport: http() });
  const wei = await publicClient.getBalance({ address: address as `0x${string}` });
  return Number(wei / 1_000_000_000_000n);
}
