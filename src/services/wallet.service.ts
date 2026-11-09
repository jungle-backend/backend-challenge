import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { Money } from '../domain/money';
import { LedgerDirection, WagerKind, WagerStatus } from '../domain/wager';
import { WalletBalanceChanged, WagerTransactionProcessed } from '../domain/events';
import { enqueueEvent } from './outbox';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class WalletService {
  constructor(private readonly dataSource: DataSource) {}

  async create(playerId: string, initialBalance: Money): Promise<Record<string, unknown>> {
    if (initialBalance.isNegative()) throw new ConflictException({ code: 'INVALID_AMOUNT' });
    const walletId = randomUUID();
    const openingId = randomUUID();

    try {
      return await this.dataSource.transaction(async (manager) => {
        const [wallet] = await manager.query(
          `INSERT INTO wallets (id, player_id, currency, balance, version)
           VALUES ($1, $2, $3, $4, 1) RETURNING *`,
          [walletId, playerId, initialBalance.toJSON().currency, initialBalance.toString()],
        ) as WalletRow[];

        if (initialBalance.isPositive()) {
          const openingKey = `opening:${walletId}`;
          const payloadHash = '0'.repeat(64);
          await manager.query(
            `INSERT INTO wager_transactions
              (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
               wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency,
               status, result_balance_amount, result_balance_currency, processed_at)
             VALUES ($1, 'SYSTEM', $2, $3, $4, $5, $6, 'opening', 'internal', $7, $8, $9, $10, $8, $9, now())`,
            [openingId, openingId, openingKey, payloadHash, walletId, playerId, WagerKind.Opening,
              initialBalance.toString(), initialBalance.currency, WagerStatus.Processed],
          );
          await manager.query(
            `INSERT INTO wallet_ledger_entries
              (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
             VALUES ($1, $2, $3, $4, $5, $6, 0, $5)`,
            [randomUUID(), walletId, openingId, LedgerDirection.Credit, initialBalance.toString(), initialBalance.currency],
          );
          await enqueueEvent(manager, WagerTransactionProcessed.from(walletId, openingId, {
            transactionId: openingId,
            providerId: 'SYSTEM',
            externalTransactionId: openingId,
            kind: WagerKind.Opening,
            status: WagerStatus.Processed,
            balance: initialBalance.toJSON(),
          }));
          await enqueueEvent(manager, WalletBalanceChanged.from(walletId, openingId, {
            walletId,
            transactionId: openingId,
            direction: LedgerDirection.Credit,
            money: initialBalance.toJSON(),
            balanceBefore: Money.zero(initialBalance.currency).toJSON(),
            balanceAfter: initialBalance.toJSON(),
            walletVersion: 1,
          }));
        }

        return this.toWalletResponse(wallet!);
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new ConflictException({ code: 'WALLET_ALREADY_EXISTS' });
      throw error;
    }
  }

  async get(walletId: string): Promise<Record<string, unknown>> {
    const rows = await this.dataSource.query('SELECT * FROM wallets WHERE id = $1', [walletId]) as WalletRow[];
    if (!rows[0]) throw new NotFoundException({ code: 'WALLET_NOT_FOUND' });
    return this.toWalletResponse(rows[0]);
  }

  async ledger(walletId: string, cursor?: string, limit = 50): Promise<Record<string, unknown>> {
    await this.get(walletId);
    const decoded = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : undefined;
    if (decoded && !/^\d{4}-\d\d-\d\dT.*\|[0-9a-f-]{36}$/i.test(decoded)) {
      throw new ConflictException({ code: 'INVALID_CURSOR' });
    }
    const [createdAt, id] = decoded?.split('|') ?? [];
    const rows = await this.dataSource.query(
      `SELECT id, transaction_id, direction, amount::text, currency, balance_before::text,
              balance_after::text, created_at
       FROM wallet_ledger_entries
       WHERE wallet_id = $1 AND ($2::timestamptz IS NULL OR (created_at, id) > ($2, $3::uuid))
       ORDER BY created_at, id LIMIT $4`,
      [walletId, createdAt ?? null, id ?? null, Math.min(Math.max(limit, 1), 100)],
    ) as Array<Record<string, unknown>>;
    const last = rows.at(-1);
    const nextCursor = last
      ? Buffer.from(`${new Date(last.created_at as string).toISOString()}|${last.id as string}`).toString('base64url')
      : null;
    return { items: rows, nextCursor };
  }

  async reconcile(walletId: string): Promise<Record<string, unknown>> {
    const rows = await this.dataSource.query(
      `SELECT w.balance::text AS stored_balance, w.currency,
              COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20,2)::text AS ledger_balance,
              COUNT(l.id)::int AS checked_entries
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
       WHERE w.id = $1 GROUP BY w.id`,
      [walletId],
    ) as Array<{ stored_balance: string; currency: string; ledger_balance: string; checked_entries: number }>;
    if (!rows[0]) throw new NotFoundException({ code: 'WALLET_NOT_FOUND' });
    const row = rows[0];
    const storedBalance = Money.from({ amount: row.stored_balance, currency: row.currency });
    const calculatedBalance = Money.from({ amount: row.ledger_balance, currency: row.currency });
    const consistent = storedBalance.equals(calculatedBalance);
    if (!consistent) console.warn(JSON.stringify({ event: 'wallet_reconciliation_mismatch', walletId }));
    return {
      walletId,
      storedBalance: storedBalance.toJSON(),
      calculatedBalance: calculatedBalance.toJSON(),
      difference: storedBalance.subtract(calculatedBalance).toJSON(),
      consistent,
      checkedEntries: row.checked_entries,
    };
  }

  static toWalletResponse(wallet: WalletRow): Record<string, unknown> {
    return {
      id: wallet.id,
      playerId: wallet.player_id,
      balance: Money.from({ amount: wallet.balance, currency: wallet.currency }).toJSON(),
      version: wallet.version,
      createdAt: wallet.created_at,
      updatedAt: wallet.updated_at,
    };
  }

  private toWalletResponse(wallet: WalletRow): Record<string, unknown> {
    return WalletService.toWalletResponse(wallet);
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
  }
}

export type { WalletRow };