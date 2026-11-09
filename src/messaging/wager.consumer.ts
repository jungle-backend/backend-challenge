import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SubmitWagerDto } from '../http/wager.dto';
import { WagerService } from '../services/wager.service';

interface WagerEnvelope {
  messageId?: string;
  data: SubmitWagerDto & { idempotencyKey: string };
}

@Injectable()
export class WagerConsumer implements OnModuleInit, OnModuleDestroy {
  private stopping = false;
  private active = false;

  constructor(private readonly sqs: SQSClient, private readonly wagers: WagerService) {}

  onModuleInit(): void {
    if (process.env.WAGER_QUEUE_URL) void this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    while (this.active) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  private async poll(): Promise<void> {
    this.active = true;
    try {
      while (!this.stopping) {
        const result = await this.sqs.send(new ReceiveMessageCommand({
          QueueUrl: process.env.WAGER_QUEUE_URL,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20,
          VisibilityTimeout: 30,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }));
        for (const message of result.Messages ?? []) {
          if (this.stopping) break;
          await this.processMessage(message);
        }
      }
    } catch {
      if (!this.stopping) console.error(JSON.stringify({ event: 'wager_consumer_poll_failed' }));
    } finally {
      this.active = false;
      if (!this.stopping) setTimeout(() => void this.poll(), 1000);
    }
  }

  private async processMessage(message: { Body?: string; ReceiptHandle?: string; MessageId?: string; Attributes?: Record<string, string> }): Promise<void> {
    if (!message.Body || !message.ReceiptHandle) return;
    try {
      const envelope = JSON.parse(message.Body) as WagerEnvelope;
      const messageId = envelope.messageId ?? message.MessageId;
      if (!messageId || !envelope.data?.idempotencyKey) throw new Error('invalid message');
      const { idempotencyKey, ...wagerData } = envelope.data;
      const dto = plainToInstance(SubmitWagerDto, wagerData);
      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
      if (errors.length) throw new Error('invalid payload');
      await this.wagers.consume(
        dto,
        idempotencyKey,
        messageId,
        'wager-transactions-v1',
      );
      await this.sqs.send(new DeleteMessageCommand({
        QueueUrl: process.env.WAGER_QUEUE_URL,
        ReceiptHandle: message.ReceiptHandle,
      }));
    } catch {
      const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
      const visibility = Math.min(2 ** Math.min(receiveCount, 8), 900);
      try {
        await this.sqs.send(new ChangeMessageVisibilityCommand({
          QueueUrl: process.env.WAGER_QUEUE_URL,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: visibility,
        }));
      } catch {
        console.error(JSON.stringify({ event: 'wager_visibility_update_failed', messageId: message.MessageId }));
      }
    }
  }
}