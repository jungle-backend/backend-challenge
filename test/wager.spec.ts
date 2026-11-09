import { describe, expect, test } from 'bun:test';
import { Money } from '../src/domain/money';
import { LedgerDirection, WagerKind, applyBalance, expectedDirection } from '../src/domain/wager';

describe('wager balance rules', () => {
  test('maps bet, win, refund, loss, and rollback directions', () => {
    expect(expectedDirection(WagerKind.Bet)).toBe(LedgerDirection.Debit);
    expect(expectedDirection(WagerKind.Win)).toBe(LedgerDirection.Credit);
    expect(expectedDirection(WagerKind.Refund)).toBe(LedgerDirection.Credit);
    expect(expectedDirection(WagerKind.Loss)).toBeUndefined();
    expect(expectedDirection(WagerKind.Rollback, WagerKind.Bet)).toBe(LedgerDirection.Credit);
    expect(expectedDirection(WagerKind.Rollback, WagerKind.Win)).toBe(LedgerDirection.Debit);
  });

  test('applies balances with immutable exact money values', () => {
    const before = Money.from({ amount: '100.00', currency: 'BRL' });
    const after = applyBalance(before, Money.from({ amount: '80.00', currency: 'BRL' }), LedgerDirection.Debit);

    expect(before.toJSON().amount).toBe('100.00');
    expect(after.toJSON().amount).toBe('20.00');
  });
});