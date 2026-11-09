import { describe, expect, test } from 'bun:test';
import { Money } from '../src/domain/money';

describe('Money', () => {
  test('uses exact minor units and always serializes two decimal places', () => {
    const result = Money.from({ amount: '1.2', currency: 'BRL' })
      .add(Money.from({ amount: '0.80', currency: 'BRL' }));

    expect(result.toJSON()).toEqual({ amount: '2.00', currency: 'BRL' });
  });

  test('rejects invalid precision, scientific notation, and negative input', () => {
    for (const amount of ['1.001', '1e3', '-1.00', 'NaN', '']) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow('INVALID_AMOUNT');
    }
  });

  test('rejects arithmetic across currencies', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'BRL' })
      .add(Money.from({ amount: '1.00', currency: 'USD' }))).toThrow('CURRENCY_MISMATCH');
  });

  test('supports negative values only for internal arithmetic', () => {
    expect(Money.from({ amount: '1.00', currency: 'BRL' }).subtract(
      Money.from({ amount: '2.00', currency: 'BRL' }),
    ).toJSON().amount).toBe('-1.00');
  });
});