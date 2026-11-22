-- 001 — Revocación de sesiones
--
-- Cada JWT lleva la versión de sesión del usuario. Al cambiar la contraseña o
-- cerrar sesión la versión sube y todos los tokens anteriores dejan de servir.
--
-- Idempotente: se puede ejecutar más de una vez.

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN usuarios.token_version IS
  'Versión de sesión. Un JWT solo es válido si lleva este mismo valor.';
