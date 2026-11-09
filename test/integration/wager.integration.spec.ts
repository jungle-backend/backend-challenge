import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Money } from '../../src/domain/money';
import { WagerKind } from '../../src/domain/wager';
import { InitialSchema1710000000000 } from '../../src/database/migrations/1710000000000-InitialSchema';
import { SubmitWagerDto } from '../../src/http/wager.dto';
import { WagerService } from '../../src/services/wager.service';
import { WalletService } from '../../src/services/wallet.service';

const integration = process.env.DATABASE_URL ? describe : describe.skip;

integration('wager PostgreSQL concurrency', () => {
  let dataSource: DataSource;
  let wallets: WalletService;
  let wagers: WagerService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      migrations: [InitialSchema1710000000000],
      migrationsRun: true,
      synchronize: false,
    });
    await dataSource.initialize();
    wallets = new WalletService(dataSource);
    wagers = new WagerService(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  test('50 identical concurrent submissions create exactly one debit', async () => {
    const wallet = await wallets.create(`player-${randomUUID()}`, Money.from({ amount: '100.00', currency: 'BRL' }));
    const dto: SubmitWagerDto = {
      providerId: 'provider-test',
      externalTransactionId: randomUUID(),
      playerId: wallet.playerId as string,
      walletId: wallet.id as string,
      roundId: 'round-parallel',
      gameId: 'test-game',
      kind: WagerKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    };
    const idempotencyKey = randomUUID();
    const results = await Promise.all(Array.from({ length: 50 }, () => wagers.submit(dto, idempotencyKey)));
    const entries = await dataSource.query(
      'SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = $1',
      [wallet.id],
    ) as Array<{ count: number }>;
    const finalWallet = await wallets.get(wallet.id as string);

    expect(results.filter((result) => result.idempotentReplay === false)).toHaveLength(1);
    expect(entries[0]?.count).toBe(1);
    expect((finalWallet.balance as { amount: string }).amount).toBe('90.00');
  });

  test('two 80.00 bets against 100.00 produce one debit and one rejection', async () => {
    const wallet = await wallets.create(`player-${randomUUID()}`, Money.from({ amount: '100.00', currency: 'BRL' }));
    const submit = (externalTransactionId: string): SubmitWagerDto => ({
      providerId: 'provider-test',
      externalTransactionId,
      playerId: wallet.playerId as string,
      walletId: wallet.id as string,
      roundId: 'round-race',
      gameId: 'test-game',
      kind: WagerKind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
    });
    const results = await Promise.all([
      wagers.submit(submit(randomUUID()), randomUUID()),
      wagers.submit(submit(randomUUID()), randomUUID()),
    ]);
    const reconciliation = await wallets.reconcile(wallet.id as string);

    expect(results.map((result) => result.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect((reconciliation.storedBalance as { amount: string }).amount).toBe('20.00');
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.checkedEntries).toBe(2);
  });

  test('inbox redelivery after commit does not apply the wager twice', async () => {
    const wallet = await wallets.create(`player-${randomUUID()}`, Money.from({ amount: '50.00', currency: 'BRL' }));
    const dto: SubmitWagerDto = {
      providerId: 'provider-test',
      externalTransactionId: randomUUID(),
      playerId: wallet.playerId as string,
      walletId: wallet.id as string,
      roundId: 'round-inbox',
      gameId: 'test-game',
      kind: WagerKind.Bet,
      money: { amount: '5.00', currency: 'BRL' },
    };

    await wagers.consume(dto, randomUUID(), randomUUID(), 'integration-consumer');
    const replay = await wagers.consume(dto, randomUUID(), randomUUID(), 'integration-consumer');
    const finalWallet = await wallets.get(wallet.id as string);

    expect(replay.status).toBe('DUPLICATE_MESSAGE');
    expect((finalWallet.balance as { amount: string }).amount).toBe('45.00');
  });

  test('same idempotency key with a different payload is a conflict', async () => {
    const wallet = await wallets.create(`player-${randomUUID()}`, Money.from({ amount: '30.00', currency: 'BRL' }));
    const dto: SubmitWagerDto = {
      providerId: 'provider-test',
      externalTransactionId: randomUUID(),
      playerId: wallet.playerId as string,
      walletId: wallet.id as string,
      roundId: 'round-idempotency',
      gameId: 'test-game',
      kind: WagerKind.Bet,
      money: { amount: '5.00', currency: 'BRL' },
    };
    const key = randomUUID();
    await wagers.submit(dto, key);

    await expect(wagers.submit({ ...dto, money: { amount: '6.00', currency: 'BRL' } }, key))
      .rejects.toMatchObject({ status: 409 });
  });

  test('refund arriving before its bet is processed after the reference appears', async () => {
    const wallet = await wallets.create(`player-${randomUUID()}`, Money.from({ amount: '100.00', currency: 'BRL' }));
    const betId = randomUUID();
    const refundId = randomUUID();
    const common = {
      providerId: 'provider-test',
      playerId: wallet.playerId as string,
      walletId: wallet.id as string,
      roundId: 'round-out-of-order',
      gameId: 'test-game',
      money: { amount: '20.00', currency: 'BRL' },
    };
    const refund = await wagers.submit({
      ...common,
      externalTransactionId: refundId,
      kind: WagerKind.Refund,
      referenceExternalTransactionId: betId,
    }, randomUUID());
    expect(refund.status).toBe('PENDING_REFERENCE');

    await wagers.submit({ ...common, externalTransactionId: betId, kind: WagerKind.Bet }, randomUUID());
    await dataSource.query(
      `UPDATE wager_transactions SET next_attempt_at = now() WHERE external_transaction_id = $1 AND provider_id = $2`,
      [refundId, 'provider-test'],
    );
    await wagers.retryPendingReferences();

    expect((await wagers.getByExternal('provider-test', refundId)).status).toBe('PROCESSED');
    expect((await wallets.reconcile(wallet.id as string)).consistent).toBe(true);
    expect(((await wallets.get(wallet.id as string)).balance as { amount: string }).amount).toBe('100.00');
  });

  test('rollback of a win debits once and a second rollback is rejected', async () => {
    const wallet = await wallets.create(`player-${randomUUID()}`, Money.from({ amount: '50.00', currency: 'BRL' }));
    const betId = randomUUID();
    const winId = randomUUID();
    const rollback = (externalTransactionId: string): SubmitWagerDto => ({
      providerId: 'provider-test',
      externalTransactionId,
      playerId: wallet.playerId as string,
      walletId: wallet.id as string,
      roundId: 'round-rollback',
      gameId: 'test-game',
      kind: WagerKind.Rollback,
      money: { amount: '20.00', currency: 'BRL' },
      referenceExternalTransactionId: winId,
    });

    await wagers.submit({ ...rollback(betId), kind: WagerKind.Bet, referenceExternalTransactionId: undefined, money: { amount: '10.00', currency: 'BRL' } }, randomUUID());
    await wagers.submit({ ...rollback(winId), kind: WagerKind.Win, referenceExternalTransactionId: betId }, randomUUID());
    const first = await wagers.submit(rollback(randomUUID()), randomUUID());
    const second = await wagers.submit(rollback(randomUUID()), randomUUID());

    expect(first.status).toBe('PROCESSED');
    expect(second.status).toBe('REJECTED');
    expect(second.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(((await wallets.get(wallet.id as string)).balance as { amount: string }).amount).toBe('40.00');
  });
});