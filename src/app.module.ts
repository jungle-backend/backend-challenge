import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HealthController, MetricsController, WagerController, WalletController } from './http/controllers';
import { InitialSchema1710000000000 } from './database/migrations/1710000000000-InitialSchema';
import { WagerService } from './services/wager.service';
import { WalletService } from './services/wallet.service';
import { HealthService } from './services/health.service';
import { SqsModule } from './messaging/sqs.module';
import { NoopProviderIdentityGuard } from './http/provider-identity.guard';
import { MetricsService } from './services/metrics.service';

@Module({
	imports: [
		TypeOrmModule.forRoot({
			type: 'postgres',
			url: process.env.DATABASE_URL ?? 'postgres://wager:wager@localhost:5432/wager',
			migrations: [InitialSchema1710000000000],
			migrationsRun: true,
			synchronize: false,
			logging: false,
		}),
		SqsModule,
	],
	controllers: [HealthController, MetricsController, WalletController, WagerController],
	providers: [WagerService, WalletService, HealthService, MetricsService, NoopProviderIdentityGuard],
})
export class AppModule {}