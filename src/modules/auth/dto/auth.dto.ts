import {
  IsEmail,
  IsString,
  IsNotEmpty,
  MinLength,
  IsOptional,
  IsEnum,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum UserRole {
  SUPERADMIN = 'SUPERADMIN',
  ADMIN = 'ADMIN',
  USER = 'USER',
}

export class LoginDto {
  @ApiProperty({ example: 'admin@empresa.com' })
  @IsEmail({}, { message: 'El email no es válido' })
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @IsNotEmpty()
  password: string;
}

export class RegisterUserDto {
  @ApiProperty({ example: 'admin@empresa.com' })
  @IsEmail({}, { message: 'El email no es válido' })
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'SecurePass123!', minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  @IsNotEmpty()
  password: string;

  @ApiProperty({ enum: UserRole, default: UserRole.USER })
  @IsEnum(UserRole)
  @IsOptional()
  rol?: UserRole;

  @ApiPropertyOptional({
    description: 'ID del tenant al que pertenece el usuario',
  })
  @IsUUID()
  @IsOptional()
  tenantId?: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  @IsNotEmpty()
  newPassword: string;
}

export class AuthResponseDto {
  @ApiProperty()
  accessToken: string;

  @ApiProperty()
  refreshToken: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType: string;

  @ApiProperty({ description: 'Segundos restantes para la expiración del accessToken', example: 3600 })
  expiresIn: number;

  @ApiProperty({ description: 'Timestamp exacto de expiración', example: '2026-05-02T12:00:00.000Z' })
  expiresAt: string;

  @ApiProperty()
  user: {
    id: string;
    email: string;
    rol: string;
    tenantId: string | null;
  };
}

export class JwtPayload {
  sub: string;
  email: string;
  rol: UserRole;
  tenantId: string | null;
  type?: 'access' | 'refresh';
  /**
   * Versión de sesión del usuario al emitir el token. Si ya no coincide con
   * usuarios.token_version, el token fue revocado (logout o cambio de clave).
   * Los tokens emitidos antes de existir este campo cuentan como versión 0.
   */
  tokenVersion?: number;
  iat?: number;
  exp?: number;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'El refresh token obtenido en el login' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}
