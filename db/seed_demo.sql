-- =============================================================================
-- App IngresoCerteza — Datos Semilla Demostrativos (`seed_demo.sql`)
-- =============================================================================
-- Escenario precargado tras aplicar `schema.sql`:
--   * 7 ramos asegurables iniciales con porcentajes base y SLAs diferenciados.
--   * 6 usuarios activos (1 Admin, 2 Vendedores, 3 Prospectadores con teléfonos
--     E.164 de México y Colombia).
--   * Reglas de reparto ponderado por ramo y 3 convenios personalizados (overrides).
--   * 6 expedientes cifrados con `pgcrypto` (AES-256 + índice ciego HMAC-SHA256).
--   * 9 oportunidades distribuidas en las 7 etapas del embudo, con dos casos de
--     venta cruzada (Auto -> GMM -> Hogar; PPR -> Vida), estancamientos medibles
--     en llamada/cita/cotización y un descarte documentado.
--
-- Nota de seguridad operativa: las llaves `'ic-demo-dek-kms-v1'` y `'ic-demo-pepper-v1'`
-- son constantes exclusivas de laboratorio; en producción provienen de AWS KMS / Secret
-- Manager inyectadas en memoria de aplicación o variables efímeras de sesión.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Catálogo Inicial de los 7 Ramos de Seguros (RFP 3.C)
-- -----------------------------------------------------------------------------

INSERT INTO insurance_branches (
    id, code, display_name, line_category, base_commission_pct, sla_stagnation_hours
) VALUES
    ('10000000-0000-4000-8000-000000000001', 'VIDA',     'Vida Individual',           'PERSONAS',    12.00, 72),
    ('10000000-0000-4000-8000-000000000002', 'AHORRO',   'Ahorro Educativo y Dotal',  'PATRIMONIAL', 10.00, 72),
    ('10000000-0000-4000-8000-000000000003', 'PPR',      'Plan Personal de Retiro',   'PATRIMONIAL', 15.00, 96),
    ('10000000-0000-4000-8000-000000000004', 'GMM',      'Gastos Médicos Mayores',    'PERSONAS',    10.00, 48),
    ('10000000-0000-4000-8000-000000000005', 'AUTO',     'Seguro de Auto',            'DANOS',        8.00, 24),
    ('10000000-0000-4000-8000-000000000006', 'HOGAR',    'Seguro de Hogar Integral',  'DANOS',        9.00, 48),
    ('10000000-0000-4000-8000-000000000007', 'MASCOTAS', 'Seguro de Mascotas',        'DANOS',        7.50, 48);

-- -----------------------------------------------------------------------------
-- 2. Usuarios RBAC: 1 Administrador, 2 Vendedores y 3 Prospectadores
-- -----------------------------------------------------------------------------

INSERT INTO users (
    id,
    role,
    full_name,
    email,
    whatsapp_phone,
    password_hash,
    tax_id_encrypted,
    bank_clabe_encrypted,
    privacy_notice_accepted_at
) VALUES
    -- Administradora general
    (
        '20000000-0000-4000-8000-000000000001',
        'ADMIN',
        'Carolina Méndez Garza',
        'carolina.mendez@ingresocerteza.mx',
        '+525541238901',
        crypt('Admin#IC2026!', gen_salt('bf', 10)),
        pgp_sym_encrypt('MEGC850412AB1', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        NULL,
        NOW() - INTERVAL '60 days'
    ),
    -- Vendedor 1: especialista en líneas personales y retiro (Vida, GMM, PPR, Ahorro)
    (
        '20000000-0000-4000-8000-000000000002',
        'VENDEDOR',
        'Alejandro Vega Solís',
        'alejandro.vega@ingresocerteza.mx',
        '+525589102345',
        crypt('Agente#IC2026!', gen_salt('bf', 10)),
        pgp_sym_encrypt('VESA881103KT9', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        NULL,
        NOW() - INTERVAL '45 days'
    ),
    -- Vendedora 2: especialista en daños y líneas ágiles (Auto, Hogar, Mascotas, GMM)
    (
        '20000000-0000-4000-8000-000000000003',
        'VENDEDOR',
        'Sofía Ramírez Duarte',
        'sofia.ramirez@ingresocerteza.mx',
        '+523345678912',
        crypt('Agente#IC2026!', gen_salt('bf', 10)),
        pgp_sym_encrypt('RADS910722PL4', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        NULL,
        NOW() - INTERVAL '45 days'
    ),
    -- Prospectador 1: socio fiscalista externo (alta conversión en PPR y GMM)
    (
        '20000000-0000-4000-8000-000000000004',
        'PROSPECTADOR',
        'Roberto Domínguez Lara',
        'r.dominguez@despachofiscal.mx',
        '+525512349876',
        crypt('Ref#IC2026!', gen_salt('bf', 10)),
        pgp_sym_encrypt('DOLR820915MN2', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        pgp_sym_encrypt('012180004567890123', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        NOW() - INTERVAL '30 days'
    ),
    -- Prospectadora 2: asesora comercial en agencia automotriz (originación de Auto)
    (
        '20000000-0000-4000-8000-000000000005',
        'PROSPECTADOR',
        'Lucía Fernández Cordero',
        'lucia.fernandez@aliadosauto.mx',
        '+528123456789',
        crypt('Ref#IC2026!', gen_salt('bf', 10)),
        pgp_sym_encrypt('FECL930218QR8', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        pgp_sym_encrypt('072580009876543210', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        NOW() - INTERVAL '28 days'
    ),
    -- Prospectador 3: consultor patrimonial regional (teléfono E.164 colombiano válido)
    (
        '20000000-0000-4000-8000-000000000006',
        'PROSPECTADOR',
        'Andrés Morales Patiño',
        'andres.morales@patrimoniolatam.co',
        '+573104567890',
        crypt('Ref#IC2026!', gen_salt('bf', 10)),
        pgp_sym_encrypt('NIT901442819', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        pgp_sym_encrypt('CO-BANCOL-33491022', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        NOW() - INTERVAL '21 days'
    );

-- -----------------------------------------------------------------------------
-- 3. Reglas de Distribución Automática Round-Robin / Ponderada (RFP 3.C)
-- -----------------------------------------------------------------------------

INSERT INTO assignment_rules (
    branch_id, agent_id, weight, max_active_opportunities, assigned_count, last_assigned_at
) VALUES
    ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 3, 35, 2, NOW() - INTERVAL '2 days'),
    ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 2, 30, 1, NOW() - INTERVAL '5 days'),
    ('10000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000002', 3, 25, 1, NOW() - INTERVAL '7 days'),
    ('10000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000002', 2, 30, 1, NOW() - INTERVAL '4 days'),
    ('10000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000003', 1, 30, 0, NULL),
    ('10000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000003', 3, 50, 2, NOW() - INTERVAL '60 hours'),
    ('10000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000003', 2, 40, 1, NOW() - INTERVAL '96 hours'),
    ('10000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000003', 2, 50, 1, NOW() - INTERVAL '3 hours');

-- -----------------------------------------------------------------------------
-- 4. Overrides Personalizados de Comisión por Prospectador y Ramo (RFP 3.C)
-- -----------------------------------------------------------------------------

INSERT INTO referrer_commission_overrides (
    referrer_id, branch_id, custom_commission_pct, authorized_by_admin_id, agreement_notes
) VALUES
    -- Roberto recibe 18.00% en PPR (base 15.00%) y 12.50% en GMM (base 10.00%)
    (
        '20000000-0000-4000-8000-000000000004',
        '10000000-0000-4000-8000-000000000003',
        18.00,
        '20000000-0000-4000-8000-000000000001',
        'Convenio preferente despacho contable por tickets anuales superiores a $80,000 MXN'
    ),
    (
        '20000000-0000-4000-8000-000000000004',
        '10000000-0000-4000-8000-000000000004',
        12.50,
        '20000000-0000-4000-8000-000000000001',
        'Bono de cartera corporativa en pólizas familiares de Gastos Médicos Mayores'
    ),
    -- Lucía recibe 10.50% en AUTO (base 8.00%); en otros ramos cobra la tasa base del catálogo
    (
        '20000000-0000-4000-8000-000000000005',
        '10000000-0000-4000-8000-000000000005',
        10.50,
        '20000000-0000-4000-8000-000000000001',
        'Alianza piso de entregas de agencia automotriz Monterrey'
    );

-- -----------------------------------------------------------------------------
-- 5. Expedientes Únicos de Clientes Referidos (`prospect_dossiers` — LFPDPPP)
-- -----------------------------------------------------------------------------

INSERT INTO prospect_dossiers (
    id,
    original_referrer_id,
    prospect_full_name,
    phone_blind_index,
    prospect_phone_encrypted,
    prospect_email_encrypted,
    sensitive_underwriting_notes_encrypted,
    privacy_notice_accepted_at,
    privacy_consent_channel,
    created_at
) VALUES
    -- Expediente 1 (Lucía): Mariana Ortega — Caso demostrativo de Venta Cruzada triple (Auto + GMM + Hogar)
    (
        '30000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000005',
        'Mariana Ortega Salinas',
        encode(hmac(convert_to('+528189012345', 'UTF8'), convert_to('ic-demo-pepper-v1', 'UTF8'), 'sha256'), 'hex'),
        pgp_sym_encrypt('+528189012345', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        pgp_sym_encrypt('mariana.ortega@empresa-regia.mx', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        pgp_sym_encrypt('Sin preexistencias; solicita reconocimiento de antigüedad GMM de póliza colectiva previa.', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        NOW() - INTERVAL '18 days',
        'APP_PROSPECTADOR',
        NOW() - INTERVAL '18 days'
    ),
    -- Expediente 2 (Roberto): Héctor Castellanos — Venta Cruzada doble (PPR pagado + Vida en solicitud)
    (
        '30000000-0000-4000-8000-000000000002',
        '20000000-0000-4000-8000-000000000004',
        'Héctor Castellanos Ruiz',
        encode(hmac(convert_to('+525567890123', 'UTF8'), convert_to('ic-demo-pepper-v1', 'UTF8'), 'sha256'), 'hex'),
        pgp_sym_encrypt('+525567890123', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        pgp_sym_encrypt('hcastellanos@clinica-sur.mx', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        pgp_sym_encrypt('Médico cirujano no fumador; deducción fiscal Art. 151 LISR tope anual.', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        NOW() - INTERVAL '12 days',
        'APP_PROSPECTADOR',
        NOW() - INTERVAL '12 days'
    ),
    -- Expediente 3 (Roberto): Gabriela Téllez — Detenida en Cita Agendada
    (
        '30000000-0000-4000-8000-000000000003',
        '20000000-0000-4000-8000-000000000004',
        'Gabriela Téllez Monroy',
        encode(hmac(convert_to('+525523456789', 'UTF8'), convert_to('ic-demo-pepper-v1', 'UTF8'), 'sha256'), 'hex'),
        pgp_sym_encrypt('+525523456789', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        pgp_sym_encrypt('gtellez@arquitectos.mx', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        NULL,
        NOW() - INTERVAL '6 days',
        'WHATSAPP_OPT_IN',
        NOW() - INTERVAL '6 days'
    ),
    -- Expediente 4 (Lucía): Fernando Ibarra — Detenido en Primer Contacto
    (
        '30000000-0000-4000-8000-000000000004',
        '20000000-0000-4000-8000-000000000005',
        'Fernando Ibarra Quintero',
        encode(hmac(convert_to('+528134567890', 'UTF8'), convert_to('ic-demo-pepper-v1', 'UTF8'), 'sha256'), 'hex'),
        pgp_sym_encrypt('+528134567890', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        NULL,
        NULL,
        NOW() - INTERVAL '3 days',
        'APP_PROSPECTADOR',
        NOW() - INTERVAL '3 days'
    ),
    -- Expediente 5 (Andrés): Valeria Restrepo — Recién ingresado en Nuevo
    (
        '30000000-0000-4000-8000-000000000005',
        '20000000-0000-4000-8000-000000000006',
        'Valeria Restrepo Cárdenas',
        encode(hmac(convert_to('+573156789012', 'UTF8'), convert_to('ic-demo-pepper-v1', 'UTF8'), 'sha256'), 'hex'),
        pgp_sym_encrypt('+573156789012', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        pgp_sym_encrypt('valeria.restrepo@estudiolegal.co', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        NULL,
        NOW() - INTERVAL '3 hours',
        'PORTAL_WEB',
        NOW() - INTERVAL '3 hours'
    ),
    -- Expediente 6 (Andrés): Jorge Luis Peñaloza — Caso Descartado documentado
    (
        '30000000-0000-4000-8000-000000000006',
        '20000000-0000-4000-8000-000000000006',
        'Jorge Luis Peñaloza',
        encode(hmac(convert_to('+525590817263', 'UTF8'), convert_to('ic-demo-pepper-v1', 'UTF8'), 'sha256'), 'hex'),
        pgp_sym_encrypt('+525590817263', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        NULL,
        pgp_sym_encrypt('Antecedente quirúrgico coronario en los últimos 12 meses.', 'ic-demo-dek-kms-v1', 'cipher-algo=aes256'),
        NOW() - INTERVAL '9 days',
        'APP_PROSPECTADOR',
        NOW() - INTERVAL '9 days'
    );

-- -----------------------------------------------------------------------------
-- 6. Oportunidades y Recorrido de las 7 Etapas + Venta Cruzada
-- -----------------------------------------------------------------------------
-- Al pasar `applied_commission_pct` como NULL en la inserción, el trigger
-- `trg_before_write_opportunity` resuelve automáticamente la precedencia de
-- comisión (override personalizado vs. tasa base) y activa `is_cross_sell = TRUE`
-- cuando el expediente ya cuenta con un negocio previo.

-- 6.1. Expediente 1 (Mariana Ortega — originado por Lucía):
-- Negocio 1: Seguro de AUTO recorrido paso a paso por las 6 etapas positivas hasta POLIZA_PAGADA.
-- Resultado esperado: override de Lucía 10.50% sobre $18,500.00 = $1,942.50 LISTA_PARA_COBRO.
INSERT INTO opportunities (
    id, dossier_id, branch_id, assigned_agent_id, stage, applied_commission_pct, stage_entered_at, created_at
) VALUES (
    '40000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000005', -- AUTO
    '20000000-0000-4000-8000-000000000003', -- Sofía
    'NUEVO',
    NULL,
    NOW() - INTERVAL '18 days',
    NOW() - INTERVAL '18 days'
);

UPDATE opportunities
SET stage = 'PRIMER_CONTACTO', stage_entered_at = NOW() - INTERVAL '17 days'
WHERE id = '40000000-0000-4000-8000-000000000001';

UPDATE opportunities
SET stage = 'CITA_AGENDADA', stage_entered_at = NOW() - INTERVAL '16 days'
WHERE id = '40000000-0000-4000-8000-000000000001';

UPDATE opportunities
SET stage = 'EN_COTIZACION', estimated_premium = 19200.00, stage_entered_at = NOW() - INTERVAL '15 days'
WHERE id = '40000000-0000-4000-8000-000000000001';

UPDATE opportunities
SET stage = 'SOLICITUD_LLENADA', commission_status = 'EN_PROCESO', stage_entered_at = NOW() - INTERVAL '13 days'
WHERE id = '40000000-0000-4000-8000-000000000001';

UPDATE opportunities
SET stage = 'POLIZA_PAGADA',
    final_premium = 18500.00,
    commission_status = 'LISTA_PARA_COBRO',
    policy_number = 'POL-AUTO-2026-8841',
    stage_entered_at = NOW() - INTERVAL '11 days'
WHERE id = '40000000-0000-4000-8000-000000000001';

-- Negocio 2 (Venta Cruzada sobre Mariana Ortega): Gastos Médicos Mayores (GMM).
-- Aunque lo cierra otro vendedor (Alejandro), el expediente mantiene `original_referrer_id` = Lucía.
-- Como Lucía no tiene override en GMM, se congela la tasa base de GMM (10.00% sobre $42,000 = $4,200.00).
INSERT INTO opportunities (
    id, dossier_id, branch_id, assigned_agent_id, stage, applied_commission_pct, stage_entered_at, created_at
) VALUES (
    '40000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000004', -- GMM
    '20000000-0000-4000-8000-000000000002', -- Alejandro
    'NUEVO',
    NULL,
    NOW() - INTERVAL '10 days',
    NOW() - INTERVAL '10 days'
);

UPDATE opportunities
SET stage = 'EN_COTIZACION', estimated_premium = 42000.00, stage_entered_at = NOW() - INTERVAL '8 days'
WHERE id = '40000000-0000-4000-8000-000000000002';

UPDATE opportunities
SET stage = 'POLIZA_PAGADA',
    final_premium = 42000.00,
    commission_status = 'LISTA_PARA_COBRO',
    policy_number = 'POL-GMM-2026-3109',
    stage_entered_at = NOW() - INTERVAL '4 days'
WHERE id = '40000000-0000-4000-8000-000000000002';

-- Negocio 3 (Segunda Venta Cruzada sobre Mariana Ortega): HOGAR detenido en EN_COTIZACION (96h > SLA 48h).
INSERT INTO opportunities (
    id, dossier_id, branch_id, assigned_agent_id, stage, estimated_premium, applied_commission_pct, stage_entered_at, created_at
) VALUES (
    '40000000-0000-4000-8000-000000000003',
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000006', -- HOGAR
    '20000000-0000-4000-8000-000000000003', -- Sofía
    'EN_COTIZACION',
    9400.00,
    NULL,
    NOW() - INTERVAL '96 hours',
    NOW() - INTERVAL '5 days'
);

-- 6.2. Expediente 2 (Héctor Castellanos — originado por Roberto):
-- Negocio 4: PPR cerrado con override preferente de Roberto (18.00% sobre $96,000 = $17,280.00).
INSERT INTO opportunities (
    id,
    dossier_id,
    branch_id,
    assigned_agent_id,
    stage,
    estimated_premium,
    final_premium,
    applied_commission_pct,
    commission_status,
    policy_number,
    stage_entered_at,
    closed_at,
    created_at
) VALUES (
    '40000000-0000-4000-8000-000000000004',
    '30000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003', -- PPR
    '20000000-0000-4000-8000-000000000002', -- Alejandro
    'POLIZA_PAGADA',
    96000.00,
    96000.00,
    NULL,
    'LISTA_PARA_COBRO',
    'POL-PPR-2026-0412',
    NOW() - INTERVAL '7 days',
    NOW() - INTERVAL '7 days',
    NOW() - INTERVAL '12 days'
);

-- Negocio 5 (Venta Cruzada sobre Héctor Castellanos): VIDA en etapa 5 (SOLICITUD_LLENADA).
INSERT INTO opportunities (
    id,
    dossier_id,
    branch_id,
    assigned_agent_id,
    stage,
    estimated_premium,
    applied_commission_pct,
    commission_status,
    stage_entered_at,
    created_at
) VALUES (
    '40000000-0000-4000-8000-000000000005',
    '30000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001', -- VIDA
    '20000000-0000-4000-8000-000000000002', -- Alejandro
    'SOLICITUD_LLENADA',
    34000.00,
    NULL,
    'EN_PROCESO',
    NOW() - INTERVAL '36 hours',
    NOW() - INTERVAL '6 days'
);

-- 6.3. Expediente 3 (Gabriela Téllez): AHORRO detenido en etapa 3 (CITA_AGENDADA — 130h > SLA 72h).
INSERT INTO opportunities (
    id, dossier_id, branch_id, assigned_agent_id, stage, applied_commission_pct, stage_entered_at, created_at
) VALUES (
    '40000000-0000-4000-8000-000000000006',
    '30000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000002', -- AHORRO
    '20000000-0000-4000-8000-000000000002', -- Alejandro
    'CITA_AGENDADA',
    NULL,
    NOW() - INTERVAL '130 hours',
    NOW() - INTERVAL '6 days'
);

-- 6.4. Expediente 4 (Fernando Ibarra): AUTO detenido en etapa 2 (PRIMER_CONTACTO — 60h > SLA 24h).
INSERT INTO opportunities (
    id, dossier_id, branch_id, assigned_agent_id, stage, applied_commission_pct, stage_entered_at, created_at
) VALUES (
    '40000000-0000-4000-8000-000000000007',
    '30000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000005', -- AUTO
    '20000000-0000-4000-8000-000000000003', -- Sofía
    'PRIMER_CONTACTO',
    NULL,
    NOW() - INTERVAL '60 hours',
    NOW() - INTERVAL '3 days'
);

-- 6.5. Expediente 5 (Valeria Restrepo): MASCOTAS recién recibido en etapa 1 (NUEVO).
INSERT INTO opportunities (
    id, dossier_id, branch_id, assigned_agent_id, stage, applied_commission_pct, stage_entered_at, created_at
) VALUES (
    '40000000-0000-4000-8000-000000000008',
    '30000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000007', -- MASCOTAS
    '20000000-0000-4000-8000-000000000003', -- Sofía
    'NUEVO',
    NULL,
    NOW() - INTERVAL '3 hours',
    NOW() - INTERVAL '3 hours'
);

-- 6.6. Expediente 6 (Jorge Luis Peñaloza): VIDA transicionado a etapa 7 (DESCARTADO) con motivo formal.
INSERT INTO opportunities (
    id, dossier_id, branch_id, assigned_agent_id, stage, applied_commission_pct, stage_entered_at, created_at
) VALUES (
    '40000000-0000-4000-8000-000000000009',
    '30000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000001', -- VIDA
    '20000000-0000-4000-8000-000000000002', -- Alejandro
    'NUEVO',
    NULL,
    NOW() - INTERVAL '9 days',
    NOW() - INTERVAL '9 days'
);

UPDATE opportunities
SET stage = 'DESCARTADO',
    commission_status = 'CANCELADA',
    rejection_reason = 'Preexistencia coronaria declarada fuera de politicas de suscripcion en las aseguradoras aliadas',
    stage_entered_at = NOW() - INTERVAL '5 days'
WHERE id = '40000000-0000-4000-8000-000000000009';

-- -----------------------------------------------------------------------------
-- 7. Resúmenes Semanales de Viernes en `notification_outbox` (RFP 4.3)
-- -----------------------------------------------------------------------------
-- Nota: Las alertas de transición de etapa ya fueron generadas de forma
-- transaccional por el trigger `trg_audit_and_enqueue_stage_change`. Aquí se
-- añaden dos eventos del corte programado de los viernes (uno despachado vía
-- Meta WhatsApp Cloud API y otro en cola Push móvil).

INSERT INTO notification_outbox (
    recipient_user_id,
    opportunity_id,
    channel,
    event_type,
    template_name,
    payload,
    idempotency_key,
    status,
    attempt_count,
    provider_message_id,
    sent_at
) VALUES
    (
        '20000000-0000-4000-8000-000000000005', -- Lucía Fernández
        NULL,
        'WHATSAPP_CLOUD_API',
        'WEEKLY_FRIDAY_DIGEST',
        'ic_resumen_semanal_viernes_v1',
        jsonb_build_object(
            'iso_week', '2026-W47',
            'active_opportunities', 2,
            'paid_policies_count', 2,
            'ready_commission_mxn', 6142.50,
            'cross_sell_policies_won', 1
        ),
        'weekly_digest:20000000-0000-4000-8000-000000000005:2026-W47:WHATSAPP_CLOUD_API',
        'SENT',
        1,
        'wamid.HBgNNTIxODEyMzQ1Njc4ORUCABEYEjhGRjI5QTBCOUMxM0U0RTkA',
        NOW() - INTERVAL '2 days'
    ),
    (
        '20000000-0000-4000-8000-000000000004', -- Roberto Domínguez
        NULL,
        'PUSH_FCM',
        'WEEKLY_FRIDAY_DIGEST',
        'ic_push_resumen_viernes_v1',
        jsonb_build_object(
            'iso_week', '2026-W48',
            'active_opportunities', 2,
            'paid_policies_count', 1,
            'ready_commission_mxn', 17280.00
        ),
        'weekly_digest:20000000-0000-4000-8000-000000000004:2026-W48:PUSH_FCM',
        'PENDING',
        0,
        NULL,
        NULL
    );

COMMIT;
