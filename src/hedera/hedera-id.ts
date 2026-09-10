import type { Hex } from 'viem';

const HEDERA_ID_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Convierte un id nativo de Hedera ("shard.realm.num", p. ej. una cuenta o un
 * contrato) en su dirección EVM "long-zero" de 20 bytes: 4 bytes de shard +
 * 8 bytes de realm + 8 bytes de número de entidad, todo en hexadecimal y
 * rellenado con ceros a la izquierda. Es la dirección canónica que Hedera
 * expone para cualquier entidad nativa cuando no se le ha asignado un alias
 * EVM propio.
 *
 * Verificado en vivo contra el despliegue público de ATS en testnet: `eth_getCode` sobre `https://testnet.hashio.io/api` devuelve el mismo
 * bytecode para la dirección long-zero de `0.0.9213391` que para el alias
 * real que reporta el mirror node (`0xd1f118a40f3b02883d35909ef2517e7edd78379d`,
 * `GET https://testnet.mirrornode.hedera.com/api/v1/contracts/0.0.9213391`) —
 * el relay resuelve ambas rutas al mismo contrato, así que llamar por la
 * dirección long-zero es válido aunque el contrato tenga también un alias.
 *
 * Pura: no hace red ni construye nada credenciado.
 */
export function hederaIdToEvmAddress(id: string): Hex {
  const match = HEDERA_ID_PATTERN.exec(id);
  if (!match) {
    throw new RangeError(`id de Hedera inválido: "${id}" (se esperaba "shard.realm.num")`);
  }
  const [, shardRaw, realmRaw, numRaw] = match;
  const shard = toSafeInteger(shardRaw!, id);
  const realm = toSafeInteger(realmRaw!, id);
  const num = toSafeInteger(numRaw!, id);
  const hex = shard.toString(16).padStart(8, '0') + realm.toString(16).padStart(16, '0') + num.toString(16).padStart(16, '0');
  return `0x${hex}` as Hex;
}

function toSafeInteger(raw: string, id: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`id de Hedera inválido: "${id}" (número fuera de rango)`);
  }
  return value;
}
