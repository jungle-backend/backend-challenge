import { randomUUID } from 'node:crypto';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze(structuredClone(props.data));
  }

  toJSON(): Record<string, unknown> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

type EventData = Record<string, unknown>;

export class WagerTransactionProcessed extends IntegrationEvent<EventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<EventData>) { super(props); }

  static from(aggregateId: string, correlationId: string, data: EventData): WagerTransactionProcessed {
    return new WagerTransactionProcessed({ eventId: randomUUID(), aggregateId, correlationId, occurredAt: new Date(), data });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<EventData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<EventData>) { super(props); }

  static from(aggregateId: string, correlationId: string, data: EventData): WagerTransactionRejected {
    return new WagerTransactionRejected({ eventId: randomUUID(), aggregateId, correlationId, occurredAt: new Date(), data });
  }
}

export class WalletBalanceChanged extends IntegrationEvent<EventData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<EventData>) { super(props); }

  static from(aggregateId: string, correlationId: string, data: EventData): WalletBalanceChanged {
    return new WalletBalanceChanged({ eventId: randomUUID(), aggregateId, correlationId, occurredAt: new Date(), data });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<EventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<EventData>) { super(props); }

  static from(aggregateId: string, correlationId: string, data: EventData): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({ eventId: randomUUID(), aggregateId, correlationId, occurredAt: new Date(), data });
  }
}