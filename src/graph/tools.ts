import { fetchPositionState, fetchTokenPrice, type GraphClient } from './client.js';

export type ToolSpec = {
  name: string;
  description: string;
  priceMicroUsdc: number;
  maxStaleMs: number;
};

export const TOOLS: ToolSpec[] = [
  {
    name: 'token_price',
    description: 'Precio en USD de un token en Base, vía Token API de The Graph.',
    priceMicroUsdc: 2_000,
    maxStaleMs: 60_000,
  },
  {
    name: 'position_state',
    description: 'Estado de una posición de liquidez en Base, vía Subgraph de The Graph.',
    priceMicroUsdc: 12_000,
    maxStaleMs: 300_000,
  },
];

export async function runTool(
  name: string,
  args: Record<string, string>,
  client: GraphClient,
): Promise<unknown> {
  if (name === 'token_price') return fetchTokenPrice(client, args.contract as string);
  if (name === 'position_state') return fetchPositionState(client, args.positionId as string);
  throw new Error(`herramienta desconocida: ${name}`);
}
