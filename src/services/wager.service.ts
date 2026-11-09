import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { FailureCode, LedgerDirection, WagerKind, WagerStatus, applyBalance, expectedDirection } from '../domain/wager';
import { Money, MoneyProps } from '../domain/money';
import {
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/events';
import { SubmitWagerDto } from '../http/wager.dto';
import { enqueueEvent } from './outbox';
import { WalletRow } from './wallet.service';

interface TransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: WagerKind;
  money_amount: string;
  money_currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: WagerStatus;
  failure_code: string | null;
  result_balance_amount: string;
  result_balance_currency: string;
  replay_count: number;
  reference_attempts: number;
  next_attempt_at: Date | null;
}

interface WagerInput extends Omit<SubmitWagerDto, 'money'> {
  money: MoneyProps;
}

interface InboxContext {
  messageId: string;
  consumerName: string;
  payloadHash: string;
}

@Injectable()
export class WagerService {
  constructor(private readonly dataSource: DataSource) {}

  async submit(dto: SubmitWagerDto, idempotencyKey: string): Promise<Record<string, unknown>> {
    if (!idempotencyKey?.trim() || idempotencyKey.length > 200) {
      throw new BadRequestException({ code: 'INVALID_IDEMPOTENCY_KEY' });
    }
    if (dto.kind === WagerKind.Opening) throw new BadRequestException({ code: 'OPENING_IS_INTERNAL' });
    if ([WagerKind.Refund, WagerKind.Rollback].includes(dto.kind) && !dto.referenceExternalTransactionId) {
      throw new BadRequestException({ code: 'REFERENCE_REQUIRED' });
    }
    const money = Money.from(dto.money);
    if (!money.isPositive()) throw new BadRequestException({ code: 'AMOUNT_MUST_BE_POSITIVE' });
    const input: WagerInput = { ...dto, money: money.toJSON() };
    const payloadHash = this.hashPayload(input);
    const result = await this.process(input, idempotencyKey, payloadHash).catch((error: unknown) => {
      if (this.isUniqueViolation(error)) throw new ConflictException({ code: 'TRANSACTION_ALREADY_EXISTS' });
      throw error;
    });
    this.logOutcome(input, result, randomUUID());
    return result;
  }

  async consume(
    dto: SubmitWagerDto,
    idempotencyKey: string,
    messageId: string,
    consumerName: string,
  ): Promise<Record<string, unknown>> {
    if (dto.kind === WagerKind.Opening) throw new BadRequestException({ code: 'OPENING_IS_INTERNAL' });
    if ([WagerKind.Refund, WagerKind.Rollback].includes(dto.kind) && !dto.referenceExternalTransactionId) {
      throw new BadRequestException({ code: 'REFERENCE_REQUIRED' });
    }
    const money = Money.from(dto.money);
    if (!money.isPositive()) throw new BadRequestException({ code: 'AMOUNT_MUST_BE_POSITIVE' });
    const input: WagerInput = { ...dto, money: money.toJSON() };
    const payloadHash = this.hashPayload(input);
    const result = await this.process(input, idempotencyKey, payloadHash, {
      messageId,
      consumerName,
      payloadHash,
    });
    this.logOutcome(input, result, messageId, messageId);
    return result;
  }

  private async process(
    input: WagerInput,
    idempotencyKey: string,
    payloadHash: string,
    inbox?: InboxContext,
  ): Promise<Record<string, unknown>> {
    return this.dataSource.transaction(async (manager) => {
      if (inbox) {
        await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${inbox.consumerName}:${inbox.messageId}`,
        ]);
        const received = await manager.query(
          'SELECT processed_at, payload_hash FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2 FOR UPDATE',
          [inbox.consumerName, inbox.messageId],
        ) as Array<{ processed_at: Date | null; payload_hash: string }>;
        if (received[0] && received[0].payload_hash !== inbox.payloadHash) {
          throw new ConflictException({ code: 'MESSAGE_ID_PAYLOAD_CONFLICT' });
        }
        if (received[0]?.processed_at) return { status: 'DUPLICATE_MESSAGE', idempotentReplay: true };
        if (!received[0]) {
          await manager.query(
            `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash)
             VALUES ($1, $2, $3)`,
            [inbox.consumerName, inbox.messageId, inbox.payloadHash],
          );
        }
      }

      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [idempotencyKey]);
      const existingRows = await manager.query(
        'SELECT * FROM wager_transactions WHERE idempotency_key = $1 FOR UPDATE',
        [idempotencyKey],
      ) as TransactionRow[];
      let transaction = existingRows[0];
      if (transaction && transaction.payload_hash !== payloadHash) {
        throw new ConflictException({ code: 'IDEMPOTENCY_KEY_PAYLOAD_CONFLICT' });
      }
      if (transaction && this.isTerminal(transaction.status)) {
        await manager.query('UPDATE wager_transactions SET replay_count = replay_count + 1 WHERE id = $1', [transaction.id]);
        if (inbox) await this.markInboxProcessed(manager, inbox);
        return this.toResponse(transaction, true);
      }
      if (transaction?.status === WagerStatus.PendingReference
        && transaction.next_attempt_at && transaction.next_attempt_at > new Date()) {
        await manager.query('UPDATE wager_transactions SET replay_count = replay_count + 1 WHERE id = $1', [transaction.id]);
        if (inbox) await this.markInboxProcessed(manager, inbox);
        return this.toResponse(transaction, true);
      }

      let walletRows: WalletRow[];
      if (transaction) {
        walletRows = await manager.query('SELECT * FROM wallets WHERE id = $1 FOR UPDATE', [transaction.wallet_id]) as WalletRow[];
      } else {
        walletRows = await manager.query('SELECT * FROM wallets WHERE id = $1 FOR UPDATE', [input.walletId]) as WalletRow[];
      }
      const wallet = walletRows[0];
      if (!wallet) throw new NotFoundException({ code: 'WALLET_NOT_FOUND' });
      if (wallet.player_id !== input.playerId || wallet.currency !== input.money.currency) {
        throw new ConflictException({ code: 'WALLET_IDENTITY_OR_CURRENCY_MISMATCH' });
      }

      if (!transaction) {
        const id = randomUUID();
        const balance = Money.from({ amount: wallet.balance, currency: wallet.currency });
        const inserted = await manager.query(
          `INSERT INTO wager_transactions
            (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency,
             reference_external_transaction_id, status, result_balance_amount, result_balance_currency)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'PENDING',$14,$15)
           RETURNING *`,
          [id, input.providerId, input.externalTransactionId, idempotencyKey, payloadHash,
            wallet.id, input.playerId, input.roundId, input.gameId, input.kind,
            input.money.amount, input.money.currency, input.referenceExternalTransactionId ?? null,
            balance.toString(), balance.currency],
        ) as TransactionRow[];
        transaction = inserted[0]!;
      }

      const amount = Money.from({ amount: transaction.money_amount, currency: transaction.money_currency });
      const balanceBefore = Money.from({ amount: wallet.balance, currency: wallet.currency });
      const reference = await this.resolveReference(manager, transaction, input);
      if (reference === 'MISSING') {
        const attempts = transaction.reference_attempts + 1;
        if (attempts >= 10) {
          transaction = await this.reject(manager, transaction, FailureCode.ReferenceNotFound, balanceBefore);
        } else {
          const delaySeconds = Math.min(2 ** attempts, 300);
          await manager.query(
            `UPDATE wager_transactions SET status = 'PENDING_REFERENCE', reference_attempts = $2,
                    next_attempt_at = now() + ($3 * interval '1 second'), result_balance_amount = $4
             WHERE id = $1`,
            [transaction.id, attempts, delaySeconds, balanceBefore.toString()],
          );
          transaction.status = WagerStatus.PendingReference;
          transaction.reference_attempts = attempts;
          transaction.result_balance_amount = balanceBefore.toString();
          await enqueueEvent(manager, WagerTransactionPendingReference.from(wallet.id, transaction.id, {
            transactionId: transaction.id,
            providerId: transaction.provider_id,
            externalTransactionId: transaction.external_transaction_id,
            referenceExternalTransactionId: transaction.reference_external_transaction_id,
          }));
        }
        if (inbox) await this.markInboxProcessed(manager, inbox);
        return this.toResponse(transaction, false);
      }

      if (reference === 'INVALID') {
        transaction = await this.reject(manager, transaction, FailureCode.ReferenceInvalid, balanceBefore);
        if (inbox) await this.markInboxProcessed(manager, inbox);
        return this.toResponse(transaction, false);
      }

      if (reference) {
        const duplicateReversal = await manager.query(
          `SELECT id FROM wager_transactions
           WHERE reference_transaction_id = $1 AND kind = $2 AND status <> 'REJECTED' AND id <> $3 LIMIT 1`,
          [reference.id, transaction.kind, transaction.id],
        ) as Array<{ id: string }>;
        if (duplicateReversal[0]) {
          transaction = await this.reject(manager, transaction, FailureCode.ReferenceAlreadyReversed, balanceBefore);
          if (inbox) await this.markInboxProcessed(manager, inbox);
          return this.toResponse(transaction, false);
        }
        if (!amount.equals(Money.from({ amount: reference.money_amount, currency: reference.money_currency }))) {
          transaction = await this.reject(manager, transaction, FailureCode.ReferenceInvalid, balanceBefore);
          if (inbox) await this.markInboxProcessed(manager, inbox);
          return this.toResponse(transaction, false);
        }
        transaction.reference_transaction_id = reference.id;
      }

      const direction = expectedDirection(transaction.kind, reference?.kind);
      const balanceAfter = direction ? applyBalance(balanceBefore, amount, direction) : balanceBefore;
      if (balanceAfter.isNegative()) {
        const code = transaction.kind === WagerKind.Bet
          ? FailureCode.InsufficientBalance
          : FailureCode.ReversalInsufficientBalance;
        transaction = await this.reject(manager, transaction, code, balanceBefore);
        if (inbox) await this.markInboxProcessed(manager, inbox);
        return this.toResponse(transaction, false);
      }

      const changed = !balanceBefore.equals(balanceAfter);
      if (changed && direction) {
        await manager.query(
          `UPDATE wallets SET balance = $2, version = version + 1, updated_at = now() WHERE id = $1`,
          [wallet.id, balanceAfter.toString()],
        );
        await manager.query(
          `INSERT INTO wallet_ledger_entries
            (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [randomUUID(), wallet.id, transaction.id, direction, amount.toString(), amount.currency,
            balanceBefore.toString(), balanceAfter.toString()],
        );
      }
      await manager.query(
        `UPDATE wager_transactions SET status = 'PROCESSED', reference_transaction_id = $2,
                result_balance_amount = $3, result_balance_currency = $4, processed_at = now(), next_attempt_at = NULL
         WHERE id = $1`,
        [transaction.id, reference?.id ?? null, balanceAfter.toString(), balanceAfter.currency],
      );
      transaction.status = WagerStatus.Processed;
      transaction.reference_transaction_id = reference?.id ?? null;
      transaction.result_balance_amount = balanceAfter.toString();
      transaction.result_balance_currency = balanceAfter.currency;
      await enqueueEvent(manager, WagerTransactionProcessed.from(wallet.id, transaction.id, {
        transactionId: transaction.id,
        providerId: transaction.provider_id,
        externalTransactionId: transaction.external_transaction_id,
        kind: transaction.kind,
        status: WagerStatus.Processed,
        balance: balanceAfter.toJSON(),
      }));
      if (changed && direction) {
        await enqueueEvent(manager, WalletBalanceChanged.from(wallet.id, transaction.id, {
          walletId: wallet.id,
          transactionId: transaction.id,
          direction,
          money: amount.toJSON(),
          balanceBefore: balanceBefore.toJSON(),
          balanceAfter: balanceAfter.toJSON(),
          walletVersion: wallet.version + 1,
        }));
      }
      if (inbox) await this.markInboxProcessed(manager, inbox);
      return this.toResponse(transaction, false);
    });
  }

  async retryPendingReferences(limit = 50): Promise<void> {
    const rows = await this.dataSource.query(
      `SELECT * FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= now()
        ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    ) as TransactionRow[];
    for (const row of rows) {
      const dto = this.toDto(row);
      const hash = row.payload_hash;
      await this.process(dto, row.idempotency_key, hash).catch(() => undefined);
    }
  }

  async getById(transactionId: string): Promise<Record<string, unknown>> {
    const rows = await this.dataSource.query('SELECT * FROM wager_transactions WHERE id = $1', [transactionId]) as TransactionRow[];
    if (!rows[0]) throw new NotFoundException({ code: 'TRANSACTION_NOT_FOUND' });
    return this.toResponse(rows[0], false);
  }

  async getByExternal(providerId: string, externalTransactionId: string): Promise<Record<string, unknown>> {
    const rows = await this.dataSource.query(
      'SELECT * FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2',
      [providerId, externalTransactionId],
    ) as TransactionRow[];
    if (!rows[0]) throw new NotFoundException({ code: 'TRANSACTION_NOT_FOUND' });
    return this.toResponse(rows[0], false);
  }

  private async resolveReference(
    manager: EntityManager,
    transaction: TransactionRow,
    input: WagerInput,
  ): Promise<TransactionRow | 'MISSING' | 'INVALID' | undefined> {
    const requiresReference = [WagerKind.Refund, WagerKind.Rollback].includes(transaction.kind);
    const referenceId = transaction.reference_external_transaction_id ?? undefined;
    if (!referenceId && !requiresReference) return undefined;
    if (!referenceId) return 'INVALID';
    const rows = await manager.query(
      `SELECT * FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2`,
      [transaction.provider_id, referenceId],
    ) as TransactionRow[];
    const reference = rows[0];
    if (!reference) return 'MISSING';
    if (reference.status !== WagerStatus.Processed
      || reference.player_id !== input.playerId
      || reference.wallet_id !== input.walletId
      || reference.round_id !== input.roundId
      || reference.money_currency !== transaction.money_currency) return 'INVALID';
    if (transaction.kind === WagerKind.Refund && reference.kind !== WagerKind.Bet) return 'INVALID';
    if (transaction.kind === WagerKind.Rollback
      && ![WagerKind.Bet, WagerKind.Win, WagerKind.Refund].includes(reference.kind)) return 'INVALID';
    if (transaction.kind === WagerKind.Win && reference.kind !== WagerKind.Bet) return 'INVALID';
    return reference;
  }

  private async reject(
    manager: EntityManager,
    transaction: TransactionRow,
    code: FailureCode,
    balance: Money,
  ): Promise<TransactionRow> {
    await manager.query(
      `UPDATE wager_transactions SET status = 'REJECTED', failure_code = $2,
              result_balance_amount = $3, result_balance_currency = $4, processed_at = now(), next_attempt_at = NULL
       WHERE id = $1`,
      [transaction.id, code, balance.toString(), balance.currency],
    );
    transaction.status = WagerStatus.Rejected;
    transaction.failure_code = code;
    transaction.result_balance_amount = balance.toString();
    transaction.result_balance_currency = balance.currency;
    await enqueueEvent(manager, WagerTransactionRejected.from(transaction.wallet_id, transaction.id, {
      transactionId: transaction.id,
      providerId: transaction.provider_id,
      externalTransactionId: transaction.external_transaction_id,
      failureCode: code,
    }));
    return transaction;
  }

  private async markInboxProcessed(manager: EntityManager, inbox: InboxContext): Promise<void> {
    await manager.query(
      'UPDATE inbox_messages SET processed_at = now() WHERE consumer_name = $1 AND message_id = $2',
      [inbox.consumerName, inbox.messageId],
    );
  }

  private hashPayload(input: WagerInput): string {
    const canonical = JSON.stringify(this.sortKeys(input));
    return createHash('sha256').update(canonical).digest('hex');
  }

  private sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.sortKeys(item));
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, this.sortKeys(item)]));
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
  }

  private logOutcome(
    input: WagerInput,
    result: Record<string, unknown>,
    correlationId: string,
    messageId?: string,
  ): void {
    console.info(JSON.stringify({
      event: 'wager_request_completed',
      correlationId,
      messageId: messageId ?? null,
      transactionId: result.transactionId ?? null,
      walletId: input.walletId,
      providerId: input.providerId,
      status: result.status,
    }));
  }

  private isTerminal(status: WagerStatus): boolean {
    return [WagerStatus.Processed, WagerStatus.Rejected, WagerStatus.Failed].includes(status);
  }

  private toResponse(transaction: TransactionRow, idempotentReplay: boolean): Record<string, unknown> {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: Money.from({
        amount: transaction.result_balance_amount,
        currency: transaction.result_balance_currency,
      }).toJSON(),
      ...(transaction.failure_code ? { failureCode: transaction.failure_code } : {}),
      idempotentReplay,
    };
  }

  private toDto(row: TransactionRow): SubmitWagerDto {
    return {
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      playerId: row.player_id,
      walletId: row.wallet_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind,
      money: { amount: row.money_amount, currency: row.money_currency },
      ...(row.reference_external_transaction_id
        ? { referenceExternalTransactionId: row.reference_external_transaction_id }
        : {}),
    };
  }
}