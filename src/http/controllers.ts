import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsNotEmpty, IsString, ValidateNested } from 'class-validator';
import type { Response } from 'express';
import { Money } from '../domain/money';
import { MoneyDto, SubmitWagerDto } from './wager.dto';
import { HealthService } from '../services/health.service';
import { WagerService } from '../services/wager.service';
import { WalletService } from '../services/wallet.service';
import { NoopProviderIdentityGuard } from './provider-identity.guard';
import { MetricsService } from '../services/metrics.service';

class CreateWalletDto {
  @IsString() @IsNotEmpty()
  playerId!: string;

  @ValidateNested() @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  live(): Record<string, string> {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<Record<string, unknown>> {
    return this.health.ready();
  }
}

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async scrape(@Res() response: Response): Promise<void> {
    response.type('text/plain; version=0.0.4').send(await this.metrics.renderPrometheus());
  }
}

@Controller('wallets')
@UseGuards(NoopProviderIdentityGuard)
export class WalletController {
  constructor(private readonly wallets: WalletService) {}

  @Post()
  async create(@Body() body: CreateWalletDto): Promise<Record<string, unknown>> {
    return this.wallets.create(body.playerId, Money.from(body.initialBalance));
  }

  @Get(':walletId')
  async get(@Param('walletId', new ParseUUIDPipe()) walletId: string): Promise<Record<string, unknown>> {
    return this.wallets.get(walletId);
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 50,
  ): Promise<Record<string, unknown>> {
    return this.wallets.ledger(walletId, cursor, limit);
  }

  @Post(':walletId/reconciliation')
  async reconcile(@Param('walletId', new ParseUUIDPipe()) walletId: string): Promise<Record<string, unknown>> {
    return this.wallets.reconcile(walletId);
  }
}

@Controller()
@UseGuards(NoopProviderIdentityGuard)
export class WagerController {
  constructor(private readonly wagers: WagerService) {}

  @Post('wagering/transactions')
  @HttpCode(200)
  async submit(
    @Body() body: SubmitWagerDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    const result = await this.wagers.submit(body, idempotencyKey ?? '');
    if (result.status === 'PENDING_REFERENCE') response.status(202);
    if (result.status === 'REJECTED') response.status(422);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId', new ParseUUIDPipe()) transactionId: string): Promise<Record<string, unknown>> {
    return this.wagers.getById(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<Record<string, unknown>> {
    return this.wagers.getByExternal(providerId, externalTransactionId);
  }
}