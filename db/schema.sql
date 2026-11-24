-- =============================================================================
-- App IngresoCerteza — Esquema Relacional Principal (PostgreSQL 16+)
-- =============================================================================
-- Decisiones de arquitectura plasmadas en este DDL:
-- 1. Separación entre Expediente (`prospect_dossiers`) y Negocio (`opportunities`):
--    Un prospecto entra por un ramo inicial (ej. Auto), pero el ciclo comercial
--    habilita ventas cruzadas posteriores (GMM, Vida, PPR). Al fijar
--    `original_referrer_id` de forma inmutable en la raíz del expediente, toda
--    póliza futura liquida comisión al prospectador de origen (RFP 4.1).
-- 2. Cumplimiento técnico LFPDPPP (México — Arts. 8, 9, 16 y 22):
--    - Evidencia obligatoria de aviso de privacidad (`privacy_notice_accepted_at`).
--    - Índice ciego HMAC-SHA256 (`phone_blind_index`) para detectar duplicados en
--      O(log n) sin exponer teléfonos en texto claro dentro de páginas B-Tree.
--    - Datos personales, bancarios y notas clínicas/patrimoniales cifrados en
--      reposo mediante OpenPGP AES-256 (`pgcrypto`).
--    - Soporte de derechos ARCO (`arco_revoked_at`) sin destruir asientos contables
--      de comisiones ya devengadas ante auditorías fiscales.
-- 3. Transparencia comercial y desacoplamiento asíncrono:
--    Bitácora `append-only` protegida por trigger contra borrado o edición, unida
--    a una cola Transactional Outbox para despachar alertas por Meta WhatsApp Cloud
--    API y Push (FCM/APNs) sin acoplar la transacción SQL a latencias HTTP externas.
-- =============================================================================

BEGIN;

-- Extensión nativa para generación CSPRNG de UUIDv4, resúmenes HMAC-SHA256
-- y cifrado simétrico PGP de columnas sensibles en reposo.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. Tipos Enumerados de Dominio
-- -----------------------------------------------------------------------------

CREATE TYPE user_role AS ENUM (
    'PROSPECTADOR',
    'VENDEDOR',
    'ADMIN'
);

-- Las 7 etapas exactas definidas en el RFP 4.2.
CREATE TYPE opportunity_stage AS ENUM (
    'NUEVO',
    'PRIMER_CONTACTO',
    'CITA_AGENDADA',
    'EN_COTIZACION',
    'SOLICITUD_LLENADA',
    'POLIZA_PAGADA',
    'DESCARTADO'
);

CREATE TYPE commission_status AS ENUM (
    'PENDIENTE',
    'EN_PROCESO',
    'LISTA_PARA_COBRO',
    'CANCELADA'
);

-- -----------------------------------------------------------------------------
-- 2. Funciones de Contexto de Sesión para Row-Level Security (RLS)
-- -----------------------------------------------------------------------------
-- El pool de conexiones del backend inyecta al inicio de cada transacción:
--   SET LOCAL app.current_user_id = '<uuid>';
--   SET LOCAL app.current_user_role = 'PROSPECTADOR';
-- NULLIF evita fallos de conversión cuando la variable fue limpiada con RESET.

CREATE OR REPLACE FUNCTION app_current_user_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
    SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID;
$$;

CREATE OR REPLACE FUNCTION app_current_user_role()
RETURNS user_role
LANGUAGE sql
STABLE
AS $$
    SELECT NULLIF(current_setting('app.current_user_role', true), '')::user_role;
$$;

-- -----------------------------------------------------------------------------
-- 3. Catálogo Dinámico de Ramos de Seguros (RFP 3.C)
-- -----------------------------------------------------------------------------
-- Se modela como tabla administrable en caliente (y no como ENUM) porque la
-- dirección comercial puede abrir nuevos productos asegurables o ajustar tasas
-- base sin ejecutar migraciones DDL con bloqueo de catálogo.

CREATE TABLE insurance_branches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(40) NOT NULL UNIQUE
        CHECK (code ~ '^[A-Z0-9_]{2,40}$'),
    display_name VARCHAR(100) NOT NULL,
    line_category VARCHAR(30) NOT NULL
        CHECK (line_category IN ('PERSONAS', 'DANOS', 'PATRIMONIAL')),
    base_commission_pct NUMERIC(5,2) NOT NULL
        CHECK (base_commission_pct >= 0.00 AND base_commission_pct <= 100.00),
    sla_stagnation_hours INTEGER NOT NULL DEFAULT 72
        CHECK (sla_stagnation_hours > 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 4. Usuarios y Control de Acceso Basado en Roles (RBAC + LFPDPPP)
-- -----------------------------------------------------------------------------

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role user_role NOT NULL,
    full_name VARCHAR(140) NOT NULL
        CHECK (char_length(btrim(full_name)) >= 3),
    email VARCHAR(160) NOT NULL UNIQUE
        CHECK (email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'),
    -- Formato internacional E.164 estricto exigido por Meta WhatsApp Cloud API.
    whatsapp_phone VARCHAR(20) NOT NULL UNIQUE
        CHECK (whatsapp_phone ~ '^\+[1-9][0-9]{9,14}$'),
    password_hash TEXT NOT NULL,
    -- RFC / identificación tributaria y cuenta CLABE cifrados con pgp_sym_encrypt
    -- para dispersión de comisiones (resguardo patrimonial LFPDPPP).
    tax_id_encrypted BYTEA,
    bank_clabe_encrypted BYTEA,
    privacy_notice_accepted_at TIMESTAMPTZ NOT NULL,
    privacy_notice_version VARCHAR(24) NOT NULL DEFAULT 'LFPDPPP-v2026.1',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 5. Reglas de Asignación Automática de Vendedores por Ramo (RFP 3.C)
-- -----------------------------------------------------------------------------
-- Soporta reparto round-robin ponderado (`weight`) con tope de carga activa
-- (`max_active_opportunities`) para evitar cuellos de botella en un solo agente
-- cuando ingresan lotes masivos de referidos.

CREATE TABLE assignment_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL REFERENCES insurance_branches(id) ON DELETE RESTRICT,
    agent_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    weight SMALLINT NOT NULL DEFAULT 1
        CHECK (weight BETWEEN 1 AND 100),
    max_active_opportunities INTEGER NOT NULL DEFAULT 40
        CHECK (max_active_opportunities > 0),
    assigned_count BIGINT NOT NULL DEFAULT 0
        CHECK (assigned_count >= 0),
    last_assigned_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_assignment_branch_agent UNIQUE (branch_id, agent_id)
);

-- -----------------------------------------------------------------------------
-- 6. Excepciones / Acuerdos Personalizados de Comisión (RFP 3.C)
-- -----------------------------------------------------------------------------
-- Si existe una fila activa para `(referrer_id, branch_id)`, su porcentaje
-- prevalece sobre `insurance_branches.base_commission_pct`.

CREATE TABLE referrer_commission_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    branch_id UUID NOT NULL REFERENCES insurance_branches(id) ON DELETE RESTRICT,
    custom_commission_pct NUMERIC(5,2) NOT NULL
        CHECK (custom_commission_pct >= 0.00 AND custom_commission_pct <= 100.00),
    authorized_by_admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
    agreement_notes VARCHAR(250),
    effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_referrer_branch_override UNIQUE (referrer_id, branch_id)
);

-- -----------------------------------------------------------------------------
-- 7. Expediente Único del Cliente Referido (`prospect_dossiers` — RFP 4.1)
-- -----------------------------------------------------------------------------

CREATE TABLE prospect_dossiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Invariante raíz del negocio: el prospectador que originó el contacto conserva
    -- la atribución de por vida sobre todas las ventas cruzadas del expediente.
    original_referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    prospect_full_name VARCHAR(150) NOT NULL
        CHECK (char_length(btrim(prospect_full_name)) >= 3),
    -- Resumen hexadecimal HMAC-SHA256 del teléfono normalizado E.164. Impide que
    -- dos prospectadores registren al mismo cliente sin almacenar el teléfono en
    -- texto plano dentro de un índice único.
    phone_blind_index CHAR(64) NOT NULL UNIQUE
        CHECK (phone_blind_index ~ '^[0-9a-f]{64}$'),
    prospect_phone_encrypted BYTEA NOT NULL,
    prospect_email_encrypted BYTEA,
    -- LFPDPPP Art. 9: antecedentes médicos o patrimoniales necesarios para suscribir
    -- GMM o Vida se segregan cifrados para restringir su descifrado a suscripción.
    sensitive_underwriting_notes_encrypted BYTEA,
    privacy_notice_accepted_at TIMESTAMPTZ NOT NULL,
    privacy_consent_channel VARCHAR(32) NOT NULL
        CHECK (privacy_consent_channel IN ('APP_PROSPECTADOR', 'WHATSAPP_OPT_IN', 'PORTAL_WEB')),
    -- Marca de oposición/cancelación ARCO: detiene envíos comerciales futuros sin
    -- romper llaves foráneas de pólizas históricas ya pagadas.
    arco_revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 8. Oportunidades / Negocios por Ramo (`opportunities` — Venta Cruzada)
-- -----------------------------------------------------------------------------

CREATE TABLE opportunities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dossier_id UUID NOT NULL REFERENCES prospect_dossiers(id) ON DELETE RESTRICT,
    branch_id UUID NOT NULL REFERENCES insurance_branches(id) ON DELETE RESTRICT,
    assigned_agent_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    is_cross_sell BOOLEAN NOT NULL DEFAULT FALSE,
    stage opportunity_stage NOT NULL DEFAULT 'NUEVO',
    estimated_premium NUMERIC(12,2)
        CHECK (estimated_premium IS NULL OR estimated_premium >= 0.00),
    final_premium NUMERIC(12,2)
        CHECK (final_premium IS NULL OR final_premium >= 0.00),
    -- Porcentaje congelado al crear el negocio (override o tasa base del ramo)
    -- para que cambios futuros de catálogo no alteren negocios ya pactados.
    applied_commission_pct NUMERIC(5,2) NOT NULL
        CHECK (applied_commission_pct >= 0.00 AND applied_commission_pct <= 100.00),
    -- Monto exigible calculado por el motor SQL únicamente al pagarse la póliza.
    payable_commission_amount NUMERIC(12,2) GENERATED ALWAYS AS (
        CASE
            WHEN stage = 'POLIZA_PAGADA' AND final_premium IS NOT NULL
            THEN ROUND(final_premium * (applied_commission_pct / 100.0), 2)
            ELSE 0.00
        END
    ) STORED,
    commission_status commission_status NOT NULL DEFAULT 'PENDIENTE',
    policy_number VARCHAR(64),
    rejection_reason TEXT,
    stage_entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    last_actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Guardas deterministas de máquina de estados (RFP 4.2):
    CONSTRAINT chk_cotizacion_requires_estimated_premium CHECK (
        stage <> 'EN_COTIZACION'
        OR (estimated_premium IS NOT NULL AND estimated_premium > 0)
    ),
    CONSTRAINT chk_poliza_pagada_requires_final_and_ready_commission CHECK (
        stage <> 'POLIZA_PAGADA'
        OR (final_premium IS NOT NULL AND final_premium > 0 AND commission_status = 'LISTA_PARA_COBRO')
    ),
    CONSTRAINT chk_ready_commission_only_on_paid_policy CHECK (
        commission_status <> 'LISTA_PARA_COBRO'
        OR stage = 'POLIZA_PAGADA'
    ),
    CONSTRAINT chk_descartado_requires_documented_reason CHECK (
        stage <> 'DESCARTADO'
        OR (rejection_reason IS NOT NULL AND char_length(trim(rejection_reason)) >= 5)
    )
);

-- -----------------------------------------------------------------------------
-- 9. Bitácora Inmutable de Transiciones (`opportunity_stage_audit` — RFP 1, 4.2)
-- -----------------------------------------------------------------------------

CREATE TABLE opportunity_stage_audit (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    opportunity_id UUID NOT NULL REFERENCES opportunities(id) ON DELETE RESTRICT,
    previous_stage opportunity_stage,
    new_stage opportunity_stage NOT NULL,
    changed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    estimated_premium_snapshot NUMERIC(12,2),
    final_premium_snapshot NUMERIC(12,2),
    rejection_reason_snapshot TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 10. Cola Transactional Outbox de Notificaciones (`notification_outbox` — RFP 4.3)
-- -----------------------------------------------------------------------------
-- Garantiza entrega "at-least-once" con deduplicación vía `idempotency_key` para:
--   a) Alertas en tiempo real en cada cambio de etapa (WhatsApp Cloud API / Push).
--   b) Corte semanal de los viernes con resumen de cartera activa del prospectador.

CREATE TABLE notification_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    opportunity_id UUID REFERENCES opportunities(id) ON DELETE SET NULL,
    channel VARCHAR(30) NOT NULL
        CHECK (channel IN ('WHATSAPP_CLOUD_API', 'PUSH_FCM', 'PUSH_APNS')),
    event_type VARCHAR(40) NOT NULL
        CHECK (event_type IN (
            'STAGE_TRANSITION_ALERT',
            'COMMISSION_READY_ALERT',
            'WEEKLY_FRIDAY_DIGEST',
            'SLA_STAGNATION_ALERT'
        )),
    template_name VARCHAR(80) NOT NULL,
    payload JSONB NOT NULL,
    idempotency_key VARCHAR(160) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'DEAD_LETTER')),
    attempt_count SMALLINT NOT NULL DEFAULT 0
        CHECK (attempt_count >= 0),
    max_attempts SMALLINT NOT NULL DEFAULT 5
        CHECK (max_attempts BETWEEN 1 AND 20),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    provider_message_id VARCHAR(120),
    last_error TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 11. Triggers de Integridad de Dominio, Atribución Inmutable y Auditoría
-- =============================================================================

-- 11.1. Protección de inmutabilidad de `original_referrer_id` y coherencia RBAC
CREATE OR REPLACE FUNCTION fn_enforce_dossier_and_rbac_invariants()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_role user_role;
BEGIN
    IF TG_TABLE_NAME = 'prospect_dossiers' THEN
        IF TG_OP = 'UPDATE' AND NEW.original_referrer_id IS DISTINCT FROM OLD.original_referrer_id THEN
            RAISE EXCEPTION 'Invariante violado (RFP 4.1): original_referrer_id es inmutable; las ventas cruzadas pertenecen siempre al prospectador inicial.'
                USING ERRCODE = '23514';
        END IF;

        SELECT role INTO v_role FROM users WHERE id = NEW.original_referrer_id;
        IF v_role IS DISTINCT FROM 'PROSPECTADOR' THEN
            RAISE EXCEPTION 'original_referrer_id (%) debe corresponder a un usuario con rol PROSPECTADOR.', NEW.original_referrer_id
                USING ERRCODE = '23514';
        END IF;

        NEW.updated_at := NOW();
        RETURN NEW;

    ELSIF TG_TABLE_NAME = 'assignment_rules' THEN
        SELECT role INTO v_role FROM users WHERE id = NEW.agent_id;
        IF v_role IS DISTINCT FROM 'VENDEDOR' THEN
            RAISE EXCEPTION 'assignment_rules.agent_id (%) exige un usuario con rol VENDEDOR.', NEW.agent_id
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;

    ELSIF TG_TABLE_NAME = 'referrer_commission_overrides' THEN
        SELECT role INTO v_role FROM users WHERE id = NEW.referrer_id;
        IF v_role IS DISTINCT FROM 'PROSPECTADOR' THEN
            RAISE EXCEPTION 'referrer_commission_overrides.referrer_id (%) exige un usuario con rol PROSPECTADOR.', NEW.referrer_id
                USING ERRCODE = '23514';
        END IF;

        IF NEW.authorized_by_admin_id IS NOT NULL THEN
            SELECT role INTO v_role FROM users WHERE id = NEW.authorized_by_admin_id;
            IF v_role IS DISTINCT FROM 'ADMIN' THEN
                RAISE EXCEPTION 'authorized_by_admin_id (%) exige un usuario con rol ADMIN.', NEW.authorized_by_admin_id
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_dossier_invariants
    BEFORE INSERT OR UPDATE ON prospect_dossiers
    FOR EACH ROW EXECUTE FUNCTION fn_enforce_dossier_and_rbac_invariants();

CREATE TRIGGER trg_assignment_rule_rbac
    BEFORE INSERT OR UPDATE ON assignment_rules
    FOR EACH ROW EXECUTE FUNCTION fn_enforce_dossier_and_rbac_invariants();

CREATE TRIGGER trg_commission_override_rbac
    BEFORE INSERT OR UPDATE ON referrer_commission_overrides
    FOR EACH ROW EXECUTE FUNCTION fn_enforce_dossier_and_rbac_invariants();

-- 11.2. Resolución de precedencia de comisiones, detección de venta cruzada y sellos de etapa
CREATE OR REPLACE FUNCTION fn_before_write_opportunity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_agent_role user_role;
    v_referrer_id UUID;
BEGIN
    SELECT role INTO v_agent_role FROM users WHERE id = NEW.assigned_agent_id;
    IF v_agent_role IS DISTINCT FROM 'VENDEDOR' THEN
        RAISE EXCEPTION 'assigned_agent_id (%) debe pertenecer a un usuario con rol VENDEDOR.', NEW.assigned_agent_id
            USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'INSERT' THEN
        SELECT original_referrer_id INTO v_referrer_id
        FROM prospect_dossiers
        WHERE id = NEW.dossier_id;

        -- Si la capa de aplicación omite el porcentaje, se resuelve automáticamente
        -- la jerarquía: 1) acuerdo personalizado del prospectador, 2) tasa base del ramo.
        IF NEW.applied_commission_pct IS NULL THEN
            SELECT COALESCE(rco.custom_commission_pct, ib.base_commission_pct)
            INTO NEW.applied_commission_pct
            FROM insurance_branches ib
            LEFT JOIN referrer_commission_overrides rco
                ON rco.branch_id = ib.id
               AND rco.referrer_id = v_referrer_id
            WHERE ib.id = NEW.branch_id;
        END IF;

        -- Marca automática de venta cruzada cuando el expediente ya posee negocios previos.
        IF NOT NEW.is_cross_sell AND EXISTS (
            SELECT 1 FROM opportunities WHERE dossier_id = NEW.dossier_id
        ) THEN
            NEW.is_cross_sell := TRUE;
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.dossier_id IS DISTINCT FROM OLD.dossier_id THEN
            RAISE EXCEPTION 'No se permite reasignar una oportunidad a otro expediente.'
                USING ERRCODE = '23514';
        END IF;

        IF NEW.stage IS DISTINCT FROM OLD.stage THEN
            -- Respeta timestamps explícitos en cargas históricas/pruebas; en operación
            -- estándar estampa el instante exacto de entrada a la nueva etapa.
            IF NEW.stage_entered_at IS NOT DISTINCT FROM OLD.stage_entered_at THEN
                NEW.stage_entered_at := NOW();
            END IF;

            IF NEW.stage IN ('POLIZA_PAGADA', 'DESCARTADO') AND NEW.closed_at IS NULL THEN
                NEW.closed_at := NEW.stage_entered_at;
            END IF;
        END IF;

        NEW.updated_at := NOW();
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_before_write_opportunity
    BEFORE INSERT OR UPDATE ON opportunities
    FOR EACH ROW EXECUTE FUNCTION fn_before_write_opportunity();

-- 11.3. Escritura automática en bitácora de auditoría y encolado Transactional Outbox
CREATE OR REPLACE FUNCTION fn_audit_and_enqueue_stage_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_audit_id BIGINT;
    v_referrer_id UUID;
    v_prospect_name VARCHAR(150);
    v_arco_revoked TIMESTAMPTZ;
    v_branch_name VARCHAR(100);
    v_event_type VARCHAR(40);
    v_template VARCHAR(80);
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.stage IS NOT DISTINCT FROM OLD.stage THEN
        RETURN NEW;
    END IF;

    INSERT INTO opportunity_stage_audit (
        opportunity_id,
        previous_stage,
        new_stage,
        changed_by_user_id,
        estimated_premium_snapshot,
        final_premium_snapshot,
        rejection_reason_snapshot,
        occurred_at
    ) VALUES (
        NEW.id,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.stage ELSE NULL END,
        NEW.stage,
        COALESCE(NEW.last_actor_user_id, NEW.assigned_agent_id),
        NEW.estimated_premium,
        NEW.final_premium,
        NEW.rejection_reason,
        NEW.stage_entered_at
    )
    RETURNING id INTO v_audit_id;

    SELECT pd.original_referrer_id, pd.prospect_full_name, pd.arco_revoked_at
    INTO v_referrer_id, v_prospect_name, v_arco_revoked
    FROM prospect_dossiers pd
    WHERE pd.id = NEW.dossier_id;

    SELECT display_name INTO v_branch_name
    FROM insurance_branches
    WHERE id = NEW.branch_id;

    -- Si el titular ejerció revocación ARCO, se conserva la auditoría interna pero
    -- se suprime la emisión de mensajes con datos personales hacia canales externos.
    IF v_arco_revoked IS NULL THEN
        v_event_type := CASE
            WHEN NEW.stage = 'POLIZA_PAGADA' THEN 'COMMISSION_READY_ALERT'
            ELSE 'STAGE_TRANSITION_ALERT'
        END;

        v_template := CASE
            WHEN NEW.stage = 'POLIZA_PAGADA' THEN 'ic_comision_lista_cobro_v1'
            ELSE 'ic_avance_etapa_referido_v1'
        END;

        INSERT INTO notification_outbox (
            recipient_user_id,
            opportunity_id,
            channel,
            event_type,
            template_name,
            payload,
            idempotency_key
        ) VALUES (
            v_referrer_id,
            NEW.id,
            'WHATSAPP_CLOUD_API',
            v_event_type,
            v_template,
            jsonb_build_object(
                'audit_id', v_audit_id,
                'opportunity_id', NEW.id,
                'prospect_name', v_prospect_name,
                'branch', v_branch_name,
                'is_cross_sell', NEW.is_cross_sell,
                'previous_stage', CASE WHEN TG_OP = 'UPDATE' THEN OLD.stage ELSE NULL END,
                'new_stage', NEW.stage,
                'payable_commission_amount', NEW.payable_commission_amount,
                'rejection_reason', NEW.rejection_reason
            ),
            'stage_audit:' || v_audit_id || ':WHATSAPP_CLOUD_API'
        );
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_audit_and_enqueue_stage_change
    AFTER INSERT OR UPDATE OF stage ON opportunities
    FOR EACH ROW EXECUTE FUNCTION fn_audit_and_enqueue_stage_change();

-- 11.4. Candado de inmutabilidad sobre `opportunity_stage_audit`
CREATE OR REPLACE FUNCTION fn_forbid_stage_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Operación % denegada: opportunity_stage_audit es un registro contable y comercial inmutable (append-only).', TG_OP
        USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER trg_forbid_stage_audit_mutation
    BEFORE UPDATE OR DELETE ON opportunity_stage_audit
    FOR EACH ROW EXECUTE FUNCTION fn_forbid_stage_audit_mutation();

-- =============================================================================
-- 12. Índices para Escalabilidad Operativa, KPIs y Evaluación RLS (RFP 4.4)
-- =============================================================================

-- Índices B-Tree dedicados a columnas evaluadas en predicados RLS (evitan Seq Scan por petición).
CREATE INDEX idx_dossiers_referrer_created
    ON prospect_dossiers (original_referrer_id, created_at DESC);

CREATE INDEX idx_opportunities_dossier_branch
    ON opportunities (dossier_id, branch_id);

CREATE INDEX idx_opportunities_agent_stage
    ON opportunities (assigned_agent_id, stage);

CREATE INDEX idx_outbox_recipient_created
    ON notification_outbox (recipient_user_id, created_at DESC);

CREATE INDEX idx_audit_opportunity_chronology
    ON opportunity_stage_audit (opportunity_id, occurred_at DESC);

-- Índice cubriente (Index-Only Scan) para el tablero administrativo de KPIs:
-- resuelve tasa de conversión, primas cerradas y comisiones por rango de fechas y vendedor.
CREATE INDEX idx_opportunities_kpi_dashboard
    ON opportunities (created_at DESC, assigned_agent_id, branch_id, stage)
    INCLUDE (estimated_premium, final_premium, payable_commission_amount, is_cross_sell);

-- Índice parcial exclusivo de estancamiento activo (RFP 4.4):
-- indexa solo negocios detenidos en llamada, cita o cotización; ignora el histórico
-- de pólizas pagadas o descartadas que crece indefinidamente con el tiempo.
CREATE INDEX idx_opportunities_active_stagnation
    ON opportunities (stage, stage_entered_at ASC, assigned_agent_id)
    WHERE stage IN ('PRIMER_CONTACTO', 'CITA_AGENDADA', 'EN_COTIZACION');

-- Índice parcial para workers concurrentes (`SELECT ... FOR UPDATE SKIP LOCKED`) del Outbox.
CREATE INDEX idx_outbox_pending_dispatch
    ON notification_outbox (next_attempt_at ASC)
    WHERE status = 'PENDING';

-- Índice parcial para despacho round-robin de vendedores activos por ramo.
CREATE INDEX idx_assignment_rules_active_queue
    ON assignment_rules (branch_id, last_assigned_at ASC NULLS FIRST)
    WHERE is_active = TRUE;

-- =============================================================================
-- 13. Vista Analítica de Estancamiento por Etapa (Soporte Directo a KPIs RFP 4.4)
-- =============================================================================

CREATE OR REPLACE VIEW v_kpi_stagnation_breakdown AS
SELECT
    o.id AS opportunity_id,
    o.stage,
    CASE o.stage
        WHEN 'PRIMER_CONTACTO' THEN 'DETENIDO_EN_LLAMADA'
        WHEN 'CITA_AGENDADA'   THEN 'DETENIDO_EN_CITA'
        WHEN 'EN_COTIZACION'   THEN 'DETENIDO_EN_COTIZACION'
    END AS stagnation_bucket,
    ib.code AS branch_code,
    ib.display_name AS branch_name,
    ib.sla_stagnation_hours,
    ROUND(EXTRACT(EPOCH FROM (NOW() - o.stage_entered_at)) / 3600.0, 1) AS hours_in_stage,
    (EXTRACT(EPOCH FROM (NOW() - o.stage_entered_at)) / 3600.0) > ib.sla_stagnation_hours AS is_sla_breached,
    pd.original_referrer_id,
    ref_u.full_name AS referrer_name,
    o.assigned_agent_id,
    agt_u.full_name AS agent_name,
    o.estimated_premium,
    o.stage_entered_at
FROM opportunities o
JOIN prospect_dossiers pd ON pd.id = o.dossier_id
JOIN insurance_branches ib ON ib.id = o.branch_id
JOIN users ref_u ON ref_u.id = pd.original_referrer_id
JOIN users agt_u ON agt_u.id = o.assigned_agent_id
WHERE o.stage IN ('PRIMER_CONTACTO', 'CITA_AGENDADA', 'EN_COTIZACION');

-- =============================================================================
-- 14. Políticas de Row-Level Security (RLS — Aislamiento Multi-Actor)
-- =============================================================================
-- Regla de mínimo privilegio: cada Prospectador solo lee e inserta sus propios
-- expedientes; jamás observa prospectos ajenos ni altera etapas comerciales.

ALTER TABLE prospect_dossiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrer_commission_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_stage_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;

-- Políticas sobre `prospect_dossiers`
CREATE POLICY dossiers_select_own_referrer ON prospect_dossiers
    FOR SELECT
    USING (
        app_current_user_role() = 'ADMIN'
        OR (app_current_user_role() = 'PROSPECTADOR' AND original_referrer_id = app_current_user_id())
        OR (
            app_current_user_role() = 'VENDEDOR'
            AND EXISTS (
                SELECT 1 FROM opportunities o
                WHERE o.dossier_id = prospect_dossiers.id
                  AND o.assigned_agent_id = app_current_user_id()
            )
        )
    );

CREATE POLICY dossiers_insert_referrer_or_admin ON prospect_dossiers
    FOR INSERT
    WITH CHECK (
        app_current_user_role() = 'ADMIN'
        OR (app_current_user_role() = 'PROSPECTADOR' AND original_referrer_id = app_current_user_id())
    );

CREATE POLICY dossiers_update_admin_only ON prospect_dossiers
    FOR UPDATE
    USING (app_current_user_role() = 'ADMIN')
    WITH CHECK (app_current_user_role() = 'ADMIN');

-- Políticas sobre `opportunities`
CREATE POLICY opportunities_select_by_actor ON opportunities
    FOR SELECT
    USING (
        app_current_user_role() = 'ADMIN'
        OR (app_current_user_role() = 'VENDEDOR' AND assigned_agent_id = app_current_user_id())
        OR (
            app_current_user_role() = 'PROSPECTADOR'
            AND EXISTS (
                SELECT 1 FROM prospect_dossiers pd
                WHERE pd.id = opportunities.dossier_id
                  AND pd.original_referrer_id = app_current_user_id()
            )
        )
    );

CREATE POLICY opportunities_insert_agent_or_admin ON opportunities
    FOR INSERT
    WITH CHECK (
        app_current_user_role() = 'ADMIN'
        OR (app_current_user_role() = 'VENDEDOR' AND assigned_agent_id = app_current_user_id())
    );

CREATE POLICY opportunities_update_assigned_agent_or_admin ON opportunities
    FOR UPDATE
    USING (
        app_current_user_role() = 'ADMIN'
        OR (app_current_user_role() = 'VENDEDOR' AND assigned_agent_id = app_current_user_id())
    )
    WITH CHECK (
        app_current_user_role() = 'ADMIN'
        OR (app_current_user_role() = 'VENDEDOR' AND assigned_agent_id = app_current_user_id())
    );

-- Políticas sobre `referrer_commission_overrides`
CREATE POLICY overrides_select_own_or_admin ON referrer_commission_overrides
    FOR SELECT
    USING (
        app_current_user_role() = 'ADMIN'
        OR (app_current_user_role() = 'PROSPECTADOR' AND referrer_id = app_current_user_id())
    );

CREATE POLICY overrides_insert_admin ON referrer_commission_overrides
    FOR INSERT
    WITH CHECK (app_current_user_role() = 'ADMIN');

CREATE POLICY overrides_update_admin ON referrer_commission_overrides
    FOR UPDATE
    USING (app_current_user_role() = 'ADMIN')
    WITH CHECK (app_current_user_role() = 'ADMIN');

-- Políticas sobre `opportunity_stage_audit` (solo lectura; escritura vía trigger interno)
CREATE POLICY stage_audit_select_by_actor ON opportunity_stage_audit
    FOR SELECT
    USING (
        app_current_user_role() = 'ADMIN'
        OR EXISTS (
            SELECT 1
            FROM opportunities o
            JOIN prospect_dossiers pd ON pd.id = o.dossier_id
            WHERE o.id = opportunity_stage_audit.opportunity_id
              AND (
                  (app_current_user_role() = 'PROSPECTADOR' AND pd.original_referrer_id = app_current_user_id())
                  OR (app_current_user_role() = 'VENDEDOR' AND o.assigned_agent_id = app_current_user_id())
              )
        )
    );

-- Políticas sobre `notification_outbox`
CREATE POLICY outbox_select_recipient_or_admin ON notification_outbox
    FOR SELECT
    USING (
        app_current_user_role() = 'ADMIN'
        OR recipient_user_id = app_current_user_id()
    );

COMMIT;
