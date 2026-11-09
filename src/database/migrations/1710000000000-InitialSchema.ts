import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1710000000000 implements MigrationInterface {
  name = 'InitialSchema1710000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id text NOT NULL,
        currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance numeric(20,2) NOT NULL CHECK (balance >= 0),
        version integer NOT NULL CHECK (version >= 1),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (player_id, currency),
        UNIQUE (id, currency),
        UNIQUE (id, player_id, currency)
      );

      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id text NOT NULL,
        external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL UNIQUE,
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL,
        player_id text NOT NULL,
        round_id text NOT NULL,
        game_id text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        money_amount numeric(20,2) NOT NULL CHECK (money_amount >= 0),
        money_currency char(3) NOT NULL CHECK (money_currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text,
        reference_transaction_id uuid REFERENCES wager_transactions(id),
        status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code text,
        result_balance_amount numeric(20,2) NOT NULL CHECK (result_balance_amount >= 0),
        result_balance_currency char(3) NOT NULL,
        replay_count integer NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
        reference_attempts integer NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_attempt_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz,
        UNIQUE (provider_id, external_transaction_id),
        UNIQUE (id, wallet_id),
        UNIQUE (id, wallet_id, money_currency),
        UNIQUE (id, provider_id, wallet_id, player_id, round_id, money_currency),
        FOREIGN KEY (wallet_id, player_id, money_currency) REFERENCES wallets(id, player_id, currency),
        FOREIGN KEY (wallet_id, result_balance_currency) REFERENCES wallets(id, currency),
        FOREIGN KEY (reference_transaction_id, provider_id, wallet_id, player_id, round_id, money_currency)
          REFERENCES wager_transactions(id, provider_id, wallet_id, player_id, round_id, money_currency)
      );
      CREATE INDEX wager_pending_references_idx
        ON wager_transactions(next_attempt_at) WHERE status = 'PENDING_REFERENCE';
      CREATE UNIQUE INDEX wager_one_reversal_per_kind_idx
        ON wager_transactions(reference_transaction_id, kind)
        WHERE reference_transaction_id IS NOT NULL AND kind IN ('REFUND','ROLLBACK') AND status <> 'REJECTED';

      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL,
        transaction_id uuid NOT NULL UNIQUE,
        direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount numeric(20,2) NOT NULL CHECK (amount > 0),
        currency char(3) NOT NULL,
        balance_before numeric(20,2) NOT NULL CHECK (balance_before >= 0),
        balance_after numeric(20,2) NOT NULL CHECK (balance_after >= 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (wallet_id, currency) REFERENCES wallets(id, currency),
        FOREIGN KEY (transaction_id, wallet_id, currency) REFERENCES wager_transactions(id, wallet_id, money_currency),
        CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      );
      CREATE INDEX wallet_ledger_wallet_created_idx ON wallet_ledger_entries(wallet_id, created_at, id);
      CREATE FUNCTION reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'wallet ledger entries are immutable'; END;
      $$;
      CREATE TRIGGER wallet_ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        event_id uuid NOT NULL UNIQUE,
        aggregate_id uuid NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        published_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX outbox_pending_idx ON outbox_messages(next_attempt_at, created_at) WHERE published_at IS NULL;

      CREATE TABLE inbox_messages (
        message_id text NOT NULL,
        consumer_name text NOT NULL,
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS inbox_messages;
      DROP TABLE IF EXISTS outbox_messages;
      DROP TRIGGER IF EXISTS wallet_ledger_immutable ON wallet_ledger_entries;
      DROP FUNCTION IF EXISTS reject_ledger_mutation();
      DROP TABLE IF EXISTS wallet_ledger_entries;
      DROP TABLE IF EXISTS wager_transactions;
      DROP TABLE IF EXISTS wallets;
    `);
  }
}