import { Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { OutboxPublisher } from './outbox.publisher';
import { WagerConsumer } from './wager.consumer';
import { PendingReferenceWorker } from './pending-reference.worker';
import { WagerService } from '../services/wager.service';

@Module({
  providers: [
    {
      provide: SQSClient,
      useFactory: () => {
        const endpoint = process.env.AWS_ENDPOINT_URL;
        const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
        return new SQSClient({
          region: process.env.AWS_REGION ?? 'us-east-1',
          ...(endpoint ? { endpoint } : {}),
          ...(accessKeyId && secretAccessKey
            ? { credentials: { accessKeyId, secretAccessKey } }
            : endpoint ? { credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {}),
        });
      },
    },
    OutboxPublisher,
    WagerConsumer,
    PendingReferenceWorker,
    WagerService,
  ],
  exports: [SQSClient],
})
export class SqsModule {}