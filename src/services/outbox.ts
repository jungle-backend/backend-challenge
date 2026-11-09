import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { IntegrationEvent } from '../domain/events';

export async function enqueueEvent(manager: EntityManager, event: IntegrationEvent<unknown>): Promise<void> {
  await manager.query(
    `INSERT INTO outbox_messages (id, event_id, aggregate_id, event_type, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [randomUUID(), event.eventId, event.aggregateId, event.eventType, JSON.stringify(event.toJSON())],
  );
}