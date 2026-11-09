import { Money } from './money';

export enum WagerKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum FailureCode {
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
  ReversalInsufficientBalance = 'REVERSAL_INSUFFICIENT_BALANCE',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceInvalid = 'REFERENCE_INVALID',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  WalletMismatch = 'WALLET_MISMATCH',
}

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export function expectedDirection(kind: WagerKind, referenceKind?: WagerKind): LedgerDirection | undefined {
  if (kind === WagerKind.Bet) return LedgerDirection.Debit;
  if (kind === WagerKind.Win || kind === WagerKind.Refund) return LedgerDirection.Credit;
  if (kind === WagerKind.Rollback && referenceKind) {
    return referenceKind === WagerKind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit;
  }
  return undefined;
}

export function applyBalance(balance: Money, amount: Money, direction: LedgerDirection): Money {
  return direction === LedgerDirection.Credit ? balance.add(amount) : balance.subtract(amount);
}