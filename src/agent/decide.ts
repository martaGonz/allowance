export type DecisionInput = {
  priceMicroUsdc: number;
  remainingMicroUsdc: number;
  knownAgeMs: number;
  maxStaleMs: number;
};

export type Decision = { pay: true } | { pay: false; reason: 'too_expensive' | 'still_fresh' };

export function decide(input: DecisionInput): Decision {
  if (input.priceMicroUsdc > input.remainingMicroUsdc) {
    return { pay: false, reason: 'too_expensive' };
  }
  if (input.knownAgeMs < input.maxStaleMs) {
    return { pay: false, reason: 'still_fresh' };
  }
  return { pay: true };
}
