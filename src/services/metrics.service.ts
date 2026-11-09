import { Injectable } from '@nestjs/common';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DataSource } from 'typeorm';

@Injectable()
export class MetricsService {
  constructor(private readonly dataSource: DataSource, private readonly sqs: SQSClient) {}

  async renderPrometheus(): Promise<string> {
    const lines = [
      '# HELP wager_transactions_total Persisted wager transactions by status.',
      '# TYPE wager_transactions_total gauge',
    ];
    const statuses = await this.dataSource.query(
      'SELECT status, count(*)::text AS count FROM wager_transactions GROUP BY status',
    ) as Array<{ status: string; count: string }>;
    for (const row of statuses) lines.push(`wager_transactions_total{status="${row.status}"} ${row.count}`);

    const [durable] = await this.dataSource.query(`
      SELECT COALESCE(SUM(replay_count), 0)::text AS replays,
             COALESCE(SUM(reference_attempts), 0)::text AS reference_retries,
             COALESCE(SUM(attempts), 0)::text AS outbox_retries,
             COALESCE(EXTRACT(EPOCH FROM now() - MIN(created_at)), 0)::text AS outbox_lag_seconds
      FROM outbox_messages WHERE published_at IS NULL
    `) as Array<Record<string, string>>;
    const [retryTotals] = await this.dataSource.query(`
      SELECT COALESCE(SUM(replay_count), 0)::text AS replays,
             COALESCE(SUM(reference_attempts), 0)::text AS reference_retries
      FROM wager_transactions
    `) as Array<Record<string, string>>;
    const [latency] = await this.dataSource.query(`
      SELECT COALESCE(AVG(EXTRACT(EPOCH FROM processed_at - created_at) * 1000), 0)::text AS average_ms
      FROM wager_transactions WHERE processed_at IS NOT NULL
    `) as Array<{ average_ms: string }>;
    const [lockWaiters] = await this.dataSource.query(`
      SELECT count(*)::text AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `) as Array<{ count: string }>;
    let deadLetterMessages = '0';
    try {
      if (process.env.WAGER_DLQ_QUEUE_URL) {
        const result = await this.sqs.send(new GetQueueAttributesCommand({
          QueueUrl: process.env.WAGER_DLQ_QUEUE_URL,
          AttributeNames: ['ApproximateNumberOfMessages'],
        }));
        deadLetterMessages = result.Attributes?.ApproximateNumberOfMessages ?? '0';
      }
    } catch {
      deadLetterMessages = '0';
    }

    lines.push(
      '# HELP wager_idempotent_replays_total Replays detected from persistent idempotency records.',
      '# TYPE wager_idempotent_replays_total counter',
      `wager_idempotent_replays_total ${retryTotals?.replays ?? '0'}`,
      '# HELP wager_retries_total Reference and outbox retries persisted in PostgreSQL.',
      '# TYPE wager_retries_total counter',
      `wager_retries_total ${(BigInt(retryTotals?.reference_retries ?? '0') + BigInt(durable?.outbox_retries ?? '0')).toString()}`,
      '# HELP wager_dlq_messages Approximate messages visible in the SQS dead-letter queue.',
      '# TYPE wager_dlq_messages gauge',
      `wager_dlq_messages ${deadLetterMessages}`,
      '# HELP wager_db_lock_waiters Current PostgreSQL sessions waiting for a lock.',
      '# TYPE wager_db_lock_waiters gauge',
      `wager_db_lock_waiters ${lockWaiters?.count ?? '0'}`,
      '# HELP wager_outbox_lag_seconds Age of the oldest pending outbox event.',
      '# TYPE wager_outbox_lag_seconds gauge',
      `wager_outbox_lag_seconds ${durable?.outbox_lag_seconds ?? '0'}`,
      '# HELP wager_processing_average_ms Average processing time for terminal transactions.',
      '# TYPE wager_processing_average_ms gauge',
      `wager_processing_average_ms ${latency?.average_ms ?? '0'}`,
    );
    return `${lines.join('\n')}\n`;
  }
}