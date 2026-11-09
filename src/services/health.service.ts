import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DataSource } from 'typeorm';

@Injectable()
export class HealthService {
  constructor(private readonly dataSource: DataSource, private readonly sqs: SQSClient) {}

  async ready(): Promise<Record<string, unknown>> {
    const checks: Record<string, string> = {};
    try {
      await this.dataSource.query('SELECT 1');
      checks.postgres = 'ok';
    } catch {
      checks.postgres = 'unavailable';
    }
    const queueUrl = process.env.WAGER_QUEUE_URL ?? process.env.OUTBOX_QUEUE_URL;
    try {
      if (!queueUrl) throw new Error('queue url missing');
      await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }));
      checks.sqs = 'ok';
    } catch {
      checks.sqs = 'unavailable';
    }
    const ready = checks.postgres === 'ok' && checks.sqs === 'ok';
    if (!ready) throw new ServiceUnavailableException({ status: 'unavailable', checks });
    return { status: 'ok', checks };
  }
}