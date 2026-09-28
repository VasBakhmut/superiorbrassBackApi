import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class EscalateDto {
  @IsString()
  sessionId!: string;

  @IsEmail()
  customerEmail!: string;

  @IsOptional()
  @IsString()
  productCode?: string;

  @IsString()
  @MaxLength(2000)
  issueDescription!: string;
}
