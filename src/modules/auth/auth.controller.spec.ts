import { Test } from '@nestjs/testing';
import { UnauthorizedException, ConflictException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UserRole, JwtPayload } from './dto/auth.dto';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: jest.Mocked<AuthService>;

  const mockUser: JwtPayload = {
    sub: 'user-uuid-1',
    email: 'admin@test.com',
    rol: UserRole.SUPERADMIN,
    tenantId: null,
  };

  const mockAuthResponse = {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    tokenType: 'Bearer',
    expiresIn: 28800,
    expiresAt: '2026-07-13T01:00:00.000Z',
    user: {
      id: 'user-uuid-1',
      email: 'admin@test.com',
      rol: UserRole.SUPERADMIN,
      tenantId: null,
    },
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            login: jest.fn(),
            refreshToken: jest.fn(),
            register: jest.fn(),
            changePassword: jest.fn(),
            getProfile: jest.fn(),
            logout: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get(AuthController);
    authService = module.get(AuthService);

    jest.clearAllMocks();
  });

  describe('POST /auth/login', () => {
    const loginDto = { email: 'admin@test.com', password: 'Admin123!' };

    it('debe retornar AuthResponseDto cuando el login es exitoso', async () => {
      authService.login.mockResolvedValueOnce(mockAuthResponse);

      const result = await controller.login(loginDto);

      expect(result).toEqual(mockAuthResponse);
      expect(authService.login).toHaveBeenCalledWith(loginDto);
    });

    it('debe propagar UnauthorizedException si las credenciales son inválidas', async () => {
      authService.login.mockRejectedValueOnce(new UnauthorizedException('Credenciales inválidas'));

      await expect(controller.login(loginDto)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('POST /auth/refresh', () => {
    const refreshDto = { refreshToken: 'valid-refresh-token' };

    it('debe retornar nuevos tokens cuando el refresh es exitoso', async () => {
      authService.refreshToken.mockResolvedValueOnce(mockAuthResponse);

      const result = await controller.refresh(refreshDto);

      expect(result).toEqual(mockAuthResponse);
      expect(authService.refreshToken).toHaveBeenCalledWith(refreshDto);
    });

    it('debe propagar UnauthorizedException si el refresh token es inválido', async () => {
      authService.refreshToken.mockRejectedValueOnce(
        new UnauthorizedException('Refresh token inválido o expirado'),
      );

      await expect(controller.refresh(refreshDto)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('POST /auth/register', () => {
    const registerDto = {
      email: 'newuser@test.com',
      password: 'NewPass123!',
      rol: UserRole.USER,
    };

    it('debe registrar un usuario exitosamente', async () => {
      const createdUser = {
        id: 'new-uuid',
        email: registerDto.email,
        rol: registerDto.rol,
        tenantId: null,
      };
      authService.register.mockResolvedValueOnce(createdUser);

      const result = await controller.register(registerDto);

      expect(result).toEqual(createdUser);
      expect(authService.register).toHaveBeenCalledWith(registerDto);
    });

    it('debe propagar ConflictException si el email ya existe', async () => {
      authService.register.mockRejectedValueOnce(
        new ConflictException('Ya existe un usuario con el email newuser@test.com'),
      );

      await expect(controller.register(registerDto)).rejects.toThrow(ConflictException);
    });

    it('debe propagar NotFoundException si el tenant no existe', async () => {
      authService.register.mockRejectedValueOnce(
        new NotFoundException('Tenant no encontrado'),
      );

      await expect(controller.register(registerDto)).rejects.toThrow(NotFoundException);
    });
  });

  describe('GET /auth/me', () => {
    // El perfil sale de la BD (datos frescos), no del contenido del JWT
    it('debe retornar el perfil que entrega el servicio para el usuario autenticado', async () => {
      const perfil = {
        id: mockUser.sub,
        email: mockUser.email,
        rol: mockUser.rol,
        tenantId: mockUser.tenantId,
        tenantNombre: null,
        activo: true,
      };
      authService.getProfile.mockResolvedValueOnce(perfil);

      const result = await controller.getProfile(mockUser);

      expect(result).toEqual(perfil);
    });

    it('debe consultar el perfil con el sub del payload', async () => {
      const userWithTenant: JwtPayload = {
        ...mockUser,
        sub: 'tenant-user-uuid',
        tenantId: 'tenant-abc',
        rol: UserRole.ADMIN,
      };
      authService.getProfile.mockResolvedValueOnce({
        id: 'tenant-user-uuid',
        email: mockUser.email,
        rol: UserRole.ADMIN,
        tenantId: 'tenant-abc',
        tenantNombre: 'Tenant ABC',
        activo: true,
      });

      const result = await controller.getProfile(userWithTenant);

      expect(authService.getProfile).toHaveBeenCalledWith('tenant-user-uuid');
      expect(result.tenantId).toBe('tenant-abc');
    });
  });

  describe('POST /auth/logout', () => {
    it('debe revocar las sesiones del usuario autenticado', async () => {
      authService.logout.mockResolvedValueOnce(undefined);

      const result = await controller.logout(mockUser);

      expect(authService.logout).toHaveBeenCalledWith(mockUser.sub);
      expect(result).toEqual({ message: 'Sesión cerrada' });
    });
  });

  describe('PATCH /auth/change-password', () => {
    const changeDto = {
      currentPassword: 'OldPass123!',
      newPassword: 'NewPass456!',
    };

    it('debe cambiar la contraseña exitosamente', async () => {
      authService.changePassword.mockResolvedValueOnce(undefined);

      const result = await controller.changePassword(mockUser, changeDto);

      expect(result.message).toContain('Contraseña actualizada exitosamente');
      // El cambio revoca las sesiones: la respuesta debe avisarlo
      expect(result.message).toContain('Inicie sesión nuevamente');
      expect(authService.changePassword).toHaveBeenCalledWith(
        mockUser.sub,
        changeDto.currentPassword,
        changeDto.newPassword,
      );
    });

    it('debe propagar UnauthorizedException si la contraseña actual es incorrecta', async () => {
      authService.changePassword.mockRejectedValueOnce(
        new UnauthorizedException('La contraseña actual es incorrecta'),
      );

      await expect(controller.changePassword(mockUser, changeDto)).rejects.toThrow(UnauthorizedException);
    });

    it('debe propagar NotFoundException si el usuario no existe', async () => {
      authService.changePassword.mockRejectedValueOnce(
        new NotFoundException('Usuario no encontrado'),
      );

      await expect(controller.changePassword(mockUser, changeDto)).rejects.toThrow(NotFoundException);
    });

    it('debe usar el sub del JwtPayload como userId', async () => {
      authService.changePassword.mockResolvedValueOnce(undefined);

      await controller.changePassword(mockUser, changeDto);

      expect(authService.changePassword).toHaveBeenCalledWith(
        mockUser.sub,
        changeDto.currentPassword,
        changeDto.newPassword,
      );
    });
  });
});
