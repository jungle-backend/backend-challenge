export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!/^[A-Z]{3}$/.test(props.currency)) {
      throw new Error('INVALID_CURRENCY');
    }
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(props.amount)) {
      throw new Error('INVALID_AMOUNT');
    }

    const [whole, fraction = ''] = props.amount.split('.');
    return new Money(BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  static fromMinorUnits(minorUnits: bigint, currency: string): Money {
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('INVALID_CURRENCY');
    return new Money(minorUnits, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return Money.fromMinorUnits(-this.minorUnits, this.currency);
  }

  isZero(): boolean { return this.minorUnits === 0n; }
  isPositive(): boolean { return this.minorUnits > 0n; }
  isNegative(): boolean { return this.minorUnits < 0n; }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    const absolute = this.minorUnits < 0n ? -this.minorUnits : this.minorUnits;
    const sign = this.minorUnits < 0n ? '-' : '';
    const whole = absolute / 100n;
    const fraction = (absolute % 100n).toString().padStart(2, '0');
    return { amount: `${sign}${whole}.${fraction}`, currency: this.currency };
  }

  toString(): string {
    return this.toJSON().amount;
  }

  toMinorUnits(): bigint {
    return this.minorUnits;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new Error('CURRENCY_MISMATCH');
  }
}