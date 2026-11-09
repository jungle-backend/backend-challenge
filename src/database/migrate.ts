import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { InitialSchema1710000000000 } from './migrations/1710000000000-InitialSchema';

const dataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL ?? 'postgres://wager:wager@localhost:5432/wager',
  migrations: [InitialSchema1710000000000],
  synchronize: false,
});

async function main(): Promise<void> {
  try {
    await dataSource.initialize();
    if (process.argv[2] === 'down') await dataSource.undoLastMigration();
    else await dataSource.runMigrations();
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

void main();