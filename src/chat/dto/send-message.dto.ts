import { IsOptional, IsString, MaxLength } from 'class-validator';

export class SendMessageDto {
  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsString()
  @MaxLength(2000)
  message!: string;

  @IsOptional()
  @IsString()
  entryPoint?: string; // 'technical_support_page' | 'sticky_widget' | 'product_page'

  @IsOptional()
  @IsString()
  productCode?: string;
}
