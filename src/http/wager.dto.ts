import { Type } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator';
import { MoneyProps } from '../domain/money';
import { WagerKind } from '../domain/wager';

export class MoneyDto implements MoneyProps {
  @IsString()
  @Matches(/^(?:0|[1-9]\d*)\.\d{2}$/)
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

export class SubmitWagerDto {
  @IsString() @IsNotEmpty() @MaxLength(100)
  providerId!: string;

  @IsString() @IsNotEmpty() @MaxLength(200)
  externalTransactionId!: string;

  @IsString() @IsNotEmpty() @MaxLength(200)
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString() @IsNotEmpty() @MaxLength(200)
  roundId!: string;

  @IsString() @IsNotEmpty() @MaxLength(200)
  gameId!: string;

  @IsEnum(WagerKind)
  kind!: WagerKind;

  @ValidateNested() @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200)
  referenceExternalTransactionId?: string;
}