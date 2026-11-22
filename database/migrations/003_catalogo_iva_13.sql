-- 003 — Tarifa de IVA 13% (código de porcentaje 10)
--
-- La emisión valida cada impuesto contra catalogo_tarifas_impuesto; sin esta
-- fila, un detalle con IVA código 10 se rechaza antes de llegar al SRI.
--
-- Idempotente: se puede ejecutar más de una vez.

INSERT INTO catalogo_tarifas_impuesto
  (impuesto_id, codigo_porcentaje, descripcion, porcentaje, vigente_desde, activo)
SELECT i.id, '10', 'IVA 13%', 13.00, DATE '2024-01-01', true
FROM catalogo_impuestos i
WHERE i.codigo = '2'
  AND NOT EXISTS (
    SELECT 1
    FROM catalogo_tarifas_impuesto t
    WHERE t.impuesto_id = i.id
      AND t.codigo_porcentaje = '10'
  );
