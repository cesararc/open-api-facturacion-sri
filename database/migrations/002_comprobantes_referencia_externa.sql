-- 002 — Idempotencia de emisión por referencia externa
--
-- POST /sri/emitir/factura acepta `referenciaExterna` (el id de la venta en el
-- sistema que llama) y antes de emitir busca comprobantes del mismo emisor con
-- esa referencia. Este índice hace esa búsqueda directa.
--
-- No es UNIQUE a propósito: una misma venta puede tener un intento rechazado
-- y luego uno autorizado.
--
-- Idempotente: se puede ejecutar más de una vez.

CREATE INDEX IF NOT EXISTS idx_comprobantes_referencia_externa
  ON comprobantes (emisor_id, id_referencia_externa)
  WHERE id_referencia_externa IS NOT NULL;
