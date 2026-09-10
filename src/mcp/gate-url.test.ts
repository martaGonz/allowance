import { describe, it, expect } from 'vitest';
import { buildGateUrl } from './gate-url.js';

describe('construcción de la URL hacia la puerta de pago', () => {
  it('codifica los caracteres reservados de los parámetros', () => {
    expect(buildGateUrl('http://localhost:8402', 'token_price', { contract: 'a&b=c#d' })).toBe(
      'http://localhost:8402/tools/token_price?contract=a%26b%3Dc%23d',
    );
  });

  it('una dirección normal sale intacta', () => {
    expect(
      buildGateUrl('http://localhost:8402', 'token_price', {
        contract: '0x4200000000000000000000000000000000000006',
      }),
    ).toBe('http://localhost:8402/tools/token_price?contract=0x4200000000000000000000000000000000000006');
  });

  it('el valor no puede inyectar un segundo parámetro', () => {
    const url = new URL(buildGateUrl('http://x', 'position_state', { positionId: '7&admin=1' }));
    expect(url.searchParams.get('admin')).toBeNull();
    expect(url.searchParams.get('positionId')).toBe('7&admin=1');
  });
});
