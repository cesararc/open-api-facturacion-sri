import { Controller, Query, UnauthorizedException, Sse, MessageEvent } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import { Observable } from 'rxjs';
import { Public } from '../auth/decorators/public.decorator';
import { RealtimeService } from './realtime.service';
import { AuthService } from '../auth/auth.service';

@ApiTags('Realtime')
@Public()
@Controller('realtime')
export class RealtimeController {
  constructor(
    private readonly realtimeService: RealtimeService,
    private readonly authService: AuthService,
  ) {}

  @Sse('events')
  @ApiOperation({ summary: 'Stream SSE de eventos en tiempo real (requiere token como query param)' })
  @ApiQuery({ name: 'token', description: 'JWT access token', required: true })
  async events(
    @Query('token') token: string,
  ): Promise<Observable<MessageEvent>> {
    if (!token) {
      throw new UnauthorizedException('Token requerido');
    }

    const verified = this.realtimeService.validateToken(token);
    if (!verified) {
      throw new UnauthorizedException('Token inválido o expirado');
    }

    // Mismas reglas que el resto de la API: usuario activo, sesión no revocada
    // y solo access tokens (un refresh token no abre el stream).
    const payload = await this.authService.validatePayload(verified);

    const clientId = randomUUID();
    return this.realtimeService.createConnection(clientId, payload) as Observable<MessageEvent>;
  }
}
