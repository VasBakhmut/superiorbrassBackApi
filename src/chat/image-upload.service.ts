import { Injectable, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service.js';

const BUCKET = 'chat-uploads';
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);
const MAX_BYTES = 8 * 1024 * 1024; // 8MB

@Injectable()
export class ImageUploadService {
  constructor(private readonly supabase: SupabaseService) {}

  async upload(file: { buffer: Buffer; mimetype: string; size: number }): Promise<{ url: string }> {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(`Unsupported image type: ${file.mimetype}`);
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException('Image too large (max 8MB)');
    }

    const ext = file.mimetype.split('/')[1];
    const path = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${ext}`;

    const { error } = await this.supabase.client.storage
      .from(BUCKET)
      .upload(path, file.buffer, { contentType: file.mimetype });
    if (error) throw error;

    const { data } = this.supabase.client.storage.from(BUCKET).getPublicUrl(path);
    return { url: data.publicUrl };
  }
}
