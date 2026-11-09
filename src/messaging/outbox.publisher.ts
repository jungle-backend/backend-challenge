import { DeleteMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

interface OutboxRow {
  id: string;
  payload: Record<string, unknown>;
  attempts: number;
}

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopping = false;

  constructor(private readonly dataSource: DataSource, private readonly sqs: SQSClient) {}

  onModuleInit(): void {
    if (!process.env.OUTBOX_QUEUE_URL) return;
    this.timer = setInterval(() => void this.publishBatch(), 1000);
    void this.publishBatch();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  private async publishBatch(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      await this.dataSource.transaction(async (manager) => {
        const rows = await manager.query(
          `SELECT id, payload, attempts FROM outbox_messages
           WHERE published_at IS NULL AND next_attempt_at <= now()
           ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED`,
        ) as OutboxRow[];
        for (const row of rows) {
          try {
            await this.sqs.send(new SendMessageCommand({
              QueueUrl: process.env.OUTBOX_QUEUE_URL,
              MessageBody: JSON.stringify(row.payload),
              MessageGroupId: String(row.payload.aggregateId ?? 'wagers'),
              MessageDeduplicationId: String(row.payload.eventId ?? row.id),
            }));
            await manager.query('UPDATE outbox_messages SET published_at = now() WHERE id = $1', [row.id]);
          } catch (error) {
            const retrySeconds = Math.min(2 ** Math.min(row.attempts + 1, 10), 900);
            await manager.query(
              `UPDATE outbox_messages SET attempts = attempts + 1,
                      next_attempt_at = now() + ($2 * interval '1 second') WHERE id = $1`,
              [row.id, retrySeconds],
            );
            console.error(JSON.stringify({ event: 'outbox_publish_failed', outboxId: row.id }));
            if (error instanceof Error) continue;
          }
        }
      });
    } catch {
      console.error(JSON.stringify({ event: 'outbox_poll_failed' }));
    } finally {
      this.running = false;
    }
  }
}