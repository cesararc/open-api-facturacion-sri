import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { RealtimeController } from './realtime.controller';
import { RealtimeService } from './realtime.service';
import { AuthService } from '../auth/auth.service';
import { UserRole } from '../auth/dto/auth.dto';

describe('RealtimeController', () => {
  let controller: RealtimeController;
  let realtimeService: { validateToken: jest.Mock; createConnection: jest.Mock };
  let authService: { validatePayload: jest.Mock };

  const payload = {
    sub: 'user-1',
    email: 'test@test.com',
    rol: UserRole.ADMIN,
    tenantId: 't-1',
    type: 'access' as const,
    tokenVersion: 0,
  };

  beforeEach(async () => {
    realtimeService = {
      validateToken: jest.fn(),
      createConnection: jest.fn(() => ({ subscribe: jest.fn() })),
    };
    authService = {
      validatePayload: jest.fn(async (p) => p),
    };

    const module = await Test.createTestingModule({
      controllers: [RealtimeController],
      providers: [
        { provide: RealtimeService, useValue: realtimeService },
        { provide: AuthService, useValue: authService },
      ],
    }).compile();

    controller = module.get(RealtimeController);
  });

  describe('events', () => {
    it('should throw UnauthorizedException when no token provided', async () => {
      await expect(controller.events('')).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when token is invalid', async () => {
      realtimeService.validateToken.mockReturnValue(null);

      await expect(controller.events('invalid-token')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(authService.validatePayload).not.toHaveBeenCalled();
    });

    it('should create connection when token is valid', async () => {
      realtimeService.validateToken.mockReturnValue(payload);

      const result = await controller.events('valid-token');

      expect(result).toBeDefined();
      expect(realtimeService.validateToken).toHaveBeenCalledWith('valid-token');
      expect(authService.validatePayload).toHaveBeenCalledWith(payload);
      expect(realtimeService.createConnection).toHaveBeenCalledWith(
        expect.any(String),
        payload,
      );
    });

    it('no abre el stream si la sesión fue revocada o el usuario está inactivo', async () => {
      realtimeService.validateToken.mockReturnValue(payload);
      authService.validatePayload.mockRejectedValue(
        new UnauthorizedException('La sesión fue cerrada. Inicie sesión nuevamente'),
      );

      await expect(controller.events('token-revocado')).rejects.toThrow(
        'La sesión fue cerrada',
      );
      expect(realtimeService.createConnection).not.toHaveBeenCalled();
    });
  });
});
