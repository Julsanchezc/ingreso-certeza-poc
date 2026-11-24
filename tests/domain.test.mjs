import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BRANCH_CODES,
  COMMERCIAL_STAGES,
  COMMISSION_STATUS,
  INSURANCE_BRANCHES,
  ROLES,
  STAGE_CODES,
  addCrossSellOpportunity,
  buildStageAlertPayload,
  buildWeeklyDigestPayload,
  calculateOpportunityCommission,
  computeDashboardKpis,
  createDemoDataset,
  createProspectDossier,
  normalizeWhatsAppPhone,
  registerInsuranceBranch,
  resolveCommissionRate,
  transitionDossierOpportunity,
  transitionOpportunityStage,
} from '../src/domain/index.mjs';

describe('IngresoCerteza — Catálogo normativo y administración dinámica de ramos', () => {
  it('expone los 7 ramos aseguradores iniciales y las 7 etapas ordenadas del RFP', () => {
    assert.equal(INSURANCE_BRANCHES.length, 7);
    assert.deepEqual(
      INSURANCE_BRANCHES.map((b) => b.code),
      ['VIDA', 'AHORRO', 'PPR', 'GASTOS_MEDICOS', 'AUTO', 'HOGAR', 'MASCOTAS']
    );

    assert.equal(COMMERCIAL_STAGES.length, 7);
    assert.deepEqual(
      COMMERCIAL_STAGES.map((s) => [s.stepNumber, s.code, s.isTerminal]),
      [
        [1, 'NUEVO', false],
        [2, 'PRIMER_CONTACTO', false],
        [3, 'CITA_AGENDADA', false],
        [4, 'EN_COTIZACION', false],
        [5, 'SOLICITUD_LLENADA', false],
        [6, 'POLIZA_PAGADA', true],
        [7, 'DESCARTADO', true],
      ]
    );
  });

  it('permite dar de alta un ramo nuevo de forma inmutable y rechaza códigos duplicados o tasas fuera de rango', () => {
    const extended = registerInsuranceBranch(INSURANCE_BRANCHES, {
      code: 'empresarial_pyme',
      name: 'Seguro Empresarial PyME',
      defaultCommissionRate: 13.5,
    });

    assert.equal(INSURANCE_BRANCHES.length, 7);
    assert.equal(extended.length, 8);
    assert.deepEqual(extended[7], {
      code: 'EMPRESARIAL_PYME',
      name: 'Seguro Empresarial PyME',
      defaultCommissionRate: 13.5,
      active: true,
    });

    assert.throws(
      () =>
        registerInsuranceBranch(extended, {
          code: 'AUTO',
          name: 'Auto Duplicado',
          defaultCommissionRate: 10,
        }),
      /ya existe en el catálogo/i
    );

    assert.throws(
      () =>
        registerInsuranceBranch(extended, {
          code: 'CIBER',
          name: 'Riesgo Cibernético',
          defaultCommissionRate: 0,
        }),
      /mayor a 0/i
    );
  });
});

describe('IngresoCerteza — Motor de comisiones diferenciadas y exigibilidad por etapa', () => {
  const customRules = [
    {
      referrerId: 'ref-vip',
      branchCode: BRANCH_CODES.GASTOS_MEDICOS,
      ratePercent: 16.5,
      active: true,
    },
    {
      referrerId: 'ref-vip',
      branchCode: BRANCH_CODES.AUTO,
      ratePercent: 14,
      active: false, // regla desactivada: debe caer al porcentaje base del ramo (10%)
    },
  ];

  it('prioriza reglas específicas activas (prospectador + ramo) sobre el porcentaje base del ramo', () => {
    assert.equal(
      resolveCommissionRate({
        referrerId: 'ref-vip',
        branchCode: BRANCH_CODES.GASTOS_MEDICOS,
        customRules,
      }),
      16.5
    );

    assert.equal(
      resolveCommissionRate({
        referrerId: 'ref-estandar',
        branchCode: BRANCH_CODES.GASTOS_MEDICOS,
        customRules,
      }),
      12
    );

    assert.equal(
      resolveCommissionRate({
        referrerId: 'ref-vip',
        branchCode: BRANCH_CODES.AUTO,
        customRules,
      }),
      10
    );
  });

  it('habilita LISTA_PARA_COBRO exclusivamente en POLIZA_PAGADA (etapa 6) y redondea centavos sin deriva binaria', () => {
    const stage1 = calculateOpportunityCommission({
      stage: STAGE_CODES.NUEVO,
      estimatedPremium: 0,
      referrerId: 'ref-vip',
      branchCode: BRANCH_CODES.GASTOS_MEDICOS,
      customRules,
    });
    assert.equal(stage1.commissionStatus, COMMISSION_STATUS.PENDIENTE);
    assert.equal(stage1.commissionAmount, 0);

    const stage4 = calculateOpportunityCommission({
      stage: STAGE_CODES.EN_COTIZACION,
      estimatedPremium: 19999.99,
      referrerId: 'ref-vip',
      branchCode: BRANCH_CODES.GASTOS_MEDICOS,
      customRules,
    });
    assert.equal(stage4.commissionStatus, COMMISSION_STATUS.EN_PROCESO);
    assert.equal(stage4.commissionAmount, 3300);

    const stage5 = calculateOpportunityCommission({
      stage: STAGE_CODES.SOLICITUD_LLENADA,
      estimatedPremium: 19999.99,
      referrerId: 'ref-vip',
      branchCode: BRANCH_CODES.GASTOS_MEDICOS,
      customRules,
    });
    assert.equal(stage5.commissionStatus, COMMISSION_STATUS.EN_PROCESO);

    const stage6 = calculateOpportunityCommission({
      stage: STAGE_CODES.POLIZA_PAGADA,
      estimatedPremium: 19999.99,
      finalPremium: 18500.35,
      referrerId: 'ref-vip',
      branchCode: BRANCH_CODES.GASTOS_MEDICOS,
      customRules,
    });
    assert.equal(stage6.commissionStatus, COMMISSION_STATUS.LISTA_PARA_COBRO);
    assert.equal(stage6.baseAmount, 18500.35);
    assert.equal(stage6.commissionAmount, 3052.56);

    const stage7 = calculateOpportunityCommission({
      stage: STAGE_CODES.DESCARTADO,
      estimatedPremium: 19999.99,
      referrerId: 'ref-vip',
      branchCode: BRANCH_CODES.GASTOS_MEDICOS,
      customRules,
    });
    assert.equal(stage7.commissionStatus, COMMISSION_STATUS.CANCELADA);
    assert.equal(stage7.commissionAmount, 0);
  });
});

describe('IngresoCerteza — Expediente multi-ramo, Venta Cruzada y máquina de 7 etapas', () => {
  const customRules = [
    {
      referrerId: 'ref-origen',
      branchCode: BRANCH_CODES.GASTOS_MEDICOS,
      ratePercent: 17,
      active: true,
    },
  ];

  it('crea un expediente multi-ramo sellando la atribución original contra mutaciones', () => {
    const dossier = createProspectDossier({
      id: 'dos-test-1',
      fullName: 'Laura Méndez',
      phone: '55 1234 5678',
      email: 'LAURA@CORREO.MX',
      initialBranchCodes: [BRANCH_CODES.AUTO, BRANCH_CODES.VIDA],
      referrerId: 'ref-origen',
      assignedAgentId: 'agt-1',
      customRules,
    });

    assert.equal(dossier.phone, '+525512345678');
    assert.equal(dossier.email, 'laura@correo.mx');
    assert.equal(dossier.originalReferrerId, 'ref-origen');
    assert.equal(dossier.opportunities.length, 2);
    assert.equal(dossier.opportunities[0].auditTrail.length, 1);

    assert.throws(() => {
      dossier.originalReferrerId = 'agt-usurpador';
    }, TypeError);

    assert.throws(() => {
      dossier.opportunities[0].originalReferrerId = 'agt-usurpador';
    }, TypeError);
  });

  it('preserva originalReferrerId y aplica tasa diferenciada al abrir Venta Cruzada desde VENDEDOR', () => {
    let dossier = createProspectDossier({
      id: 'dos-cross-1',
      fullName: 'Jorge Salinas',
      phone: '+52 1 55 9876 5432',
      initialBranchCodes: [BRANCH_CODES.AUTO],
      referrerId: 'ref-origen',
      assignedAgentId: 'agt-cierre',
      customRules,
    });

    dossier = addCrossSellOpportunity(dossier, {
      branchCode: BRANCH_CODES.GASTOS_MEDICOS,
      actorId: 'agt-cierre',
      actorRole: ROLES.VENDEDOR,
      notes: 'Cliente pidió cotizar GMM familiar tras asegurar su sedán.',
      customRules,
    });

    assert.equal(dossier.opportunities.length, 2);
    const crossOpp = dossier.opportunities[1];
    assert.equal(crossOpp.isCrossSell, true);
    assert.equal(crossOpp.originalReferrerId, 'ref-origen');
    assert.equal(crossOpp.commission.ratePercent, 17);

    const paidCrossOpp = transitionOpportunityStage(crossOpp, {
      nextStage: STAGE_CODES.POLIZA_PAGADA,
      actorId: 'agt-cierre',
      actorRole: ROLES.VENDEDOR,
      finalPremium: 30000,
      customRules,
    });

    assert.equal(paidCrossOpp.originalReferrerId, 'ref-origen');
    assert.equal(paidCrossOpp.commission.commissionStatus, COMMISSION_STATUS.LISTA_PARA_COBRO);
    assert.equal(paidCrossOpp.commission.commissionAmount, 5100);
  });

  it('rechaza Venta Cruzada ejecutada por PROSPECTADOR o ramo duplicado abierto sin autorización explícita', () => {
    const dossier = createProspectDossier({
      id: 'dos-rbac',
      fullName: 'Patricia Gómez',
      phone: '55 4433 2211',
      initialBranchCodes: [BRANCH_CODES.AUTO],
      referrerId: 'ref-origen',
    });

    assert.throws(
      () =>
        addCrossSellOpportunity(dossier, {
          branchCode: BRANCH_CODES.HOGAR,
          actorId: 'ref-origen',
          actorRole: ROLES.PROSPECTADOR,
        }),
      /VENDEDOR o ADMIN/i
    );

    assert.throws(
      () =>
        addCrossSellOpportunity(dossier, {
          branchCode: BRANCH_CODES.AUTO,
          actorId: 'agt-1',
          actorRole: ROLES.VENDEDOR,
        }),
      /oportunidad activa en el ramo "AUTO"/i
    );
  });

  it('impide avanzar a EN_COTIZACION sin prima estimada > 0', () => {
    const dossier = createProspectDossier({
      id: 'dos-guard-quote',
      fullName: 'Raúl Ortega',
      phone: '55 1122 3344',
      initialBranchCodes: [BRANCH_CODES.AUTO],
      referrerId: 'ref-origen',
    });

    assert.throws(
      () =>
        transitionOpportunityStage(dossier.opportunities[0], {
          nextStage: STAGE_CODES.EN_COTIZACION,
          actorId: 'agt-1',
          actorRole: ROLES.VENDEDOR,
          estimatedPremium: 0,
        }),
      /EN_COTIZACION exige registrar una prima estimada mayor a 0/i
    );
  });

  it('impide pasar a DESCARTADO sin motivo válido de al menos 5 caracteres', () => {
    const dossier = createProspectDossier({
      id: 'dos-guard-discard',
      fullName: 'Lucía Fernández',
      phone: '55 6677 8899',
      initialBranchCodes: [BRANCH_CODES.VIDA],
      referrerId: 'ref-origen',
    });

    assert.throws(
      () =>
        transitionOpportunityStage(dossier.opportunities[0], {
          nextStage: STAGE_CODES.DESCARTADO,
          actorId: 'agt-1',
          actorRole: ROLES.VENDEDOR,
          rejectionReason: 'No',
        }),
      /al menos 5 caracteres/i
    );

    const discarded = transitionOpportunityStage(dossier.opportunities[0], {
      nextStage: STAGE_CODES.DESCARTADO,
      actorId: 'agt-1',
      actorRole: ROLES.VENDEDOR,
      rejectionReason: 'Preexistencia médica no asegurable bajo políticas vigentes',
    });

    assert.equal(discarded.stage, STAGE_CODES.DESCARTADO);
    assert.equal(discarded.commission.commissionStatus, COMMISSION_STATUS.CANCELADA);
    assert.equal(discarded.auditTrail.at(-1).rejectionReason, 'Preexistencia médica no asegurable bajo políticas vigentes');
  });

  it('bloquea mutaciones de PROSPECTADOR y evita que VENDEDOR reabra pólizas terminales salvo rol ADMIN', () => {
    let dossier = createProspectDossier({
      id: 'dos-terminal',
      fullName: 'Héctor Navarro',
      phone: '55 9988 7766',
      initialBranchCodes: [BRANCH_CODES.HOGAR],
      referrerId: 'ref-origen',
    });

    assert.throws(
      () =>
        transitionOpportunityStage(dossier.opportunities[0], {
          nextStage: STAGE_CODES.PRIMER_CONTACTO,
          actorId: 'ref-origen',
          actorRole: ROLES.PROSPECTADOR,
        }),
      /solo VENDEDOR o ADMIN/i
    );

    dossier = transitionDossierOpportunity(dossier, 'dos-terminal-opp-1', {
      nextStage: STAGE_CODES.POLIZA_PAGADA,
      actorId: 'agt-1',
      actorRole: ROLES.VENDEDOR,
      finalPremium: 9500,
    });

    assert.throws(
      () =>
        transitionOpportunityStage(dossier.opportunities[0], {
          nextStage: STAGE_CODES.EN_COTIZACION,
          actorId: 'agt-1',
          actorRole: ROLES.VENDEDOR,
          estimatedPremium: 9500,
        }),
      /solo ADMIN puede reabrirla/i
    );

    const reopenedByAdmin = transitionOpportunityStage(dossier.opportunities[0], {
      nextStage: STAGE_CODES.SOLICITUD_LLENADA,
      actorId: 'adm-1',
      actorRole: ROLES.ADMIN,
      estimatedPremium: 9500,
      notes: 'Reapertura administrativa por ajuste de recibo fraccionado',
    });
    assert.equal(reopenedByAdmin.stage, STAGE_CODES.SOLICITUD_LLENADA);
    assert.equal(reopenedByAdmin.closedAt, null);
  });
});

describe('IngresoCerteza — Integración Meta WhatsApp Cloud API y Resumen Semanal', () => {
  it('normaliza teléfonos E.164 de México (+52 / +521) y Colombia (+57) y rechaza entradas corruptas', () => {
    assert.equal(normalizeWhatsAppPhone('55 1234 5678'), '+525512345678');
    assert.equal(normalizeWhatsAppPhone('+52 1 (55) 1234-5678'), '+525512345678');
    assert.equal(normalizeWhatsAppPhone('+52 55 1234 5678'), '+525512345678');
    assert.equal(normalizeWhatsAppPhone('+57 310 456 7890'), '+573104567890');
    assert.equal(normalizeWhatsAppPhone('310-456-7890', '57'), '+573104567890');

    assert.throws(() => normalizeWhatsAppPhone('12345'), /Longitud telefónica inválida/i);
    assert.throws(() => normalizeWhatsAppPhone('+52 55 123'), /México inválido/i);
    assert.throws(() => normalizeWhatsAppPhone('+57 302 12345'), /Colombia inválido/i);
    assert.throws(() => normalizeWhatsAppPhone('5512345678 ext 9'), /Formato telefónico inválido/i);
  });

  it('construye el payload oficial de alerta de etapa para Meta WhatsApp Cloud API y Push', () => {
    let dossier = createProspectDossier({
      id: 'dos-wa-1',
      fullName: 'Juan Pérez',
      phone: '55 2222 3333',
      initialBranchCodes: [BRANCH_CODES.AUTO],
      referrerId: 'ref-1',
    });

    dossier = transitionDossierOpportunity(dossier, 'dos-wa-1-opp-1', {
      nextStage: STAGE_CODES.EN_COTIZACION,
      actorId: 'agt-1',
      actorRole: ROLES.VENDEDOR,
      estimatedPremium: 15000,
    });

    const alert = buildStageAlertPayload({
      dossier,
      opportunity: dossier.opportunities[0],
      referrerName: 'Sofía Ramírez',
      referrerPhone: '+52 1 55 4123 9876',
    });

    assert.equal(alert.recipientPhone, '+525541239876');
    assert.match(
      alert.previewText,
      /Tu prospecto Juan Pérez avanzó a 'En Proceso de Cotización' en Seguro de Auto\./
    );
    assert.equal(alert.whatsappPayload.messaging_product, 'whatsapp');
    assert.equal(alert.whatsappPayload.type, 'template');
    assert.equal(
      alert.whatsappPayload.template.name,
      'estatus_prospecto_actualizado'
    );
    assert.equal(alert.pushPayload.data.stage, STAGE_CODES.EN_COTIZACION);
  });

  it('calcula los 3 indicadores del Resumen Semanal Automatizado incluyendo comisiones de Venta Cruzada', () => {
    const dataset = createDemoDataset();
    const digest = buildWeeklyDigestPayload({
      referrerId: 'ref-sofia',
      referrerName: 'Sofía Ramírez',
      referrerPhone: '+525541239876',
      dossiers: dataset.dossiers,
      customRules: dataset.customRules,
      branches: dataset.branches,
      weekLabel: 'Semana 48',
    });

    // Sofía tiene:
    // - dos-001 AUTO pagado: 18,200 * 12.5% = 2,275.00 (confirmado)
    // - dos-002 VIDA pagado: 24,000 * 15%   = 3,600.00 (confirmado) -> Total confirmado: 5,875.00
    // - dos-001 GMM (venta cruzada) en cotización: 42,000 * 16% = 6,720.00 (en cotización)
    // - dos-002 PPR en CITA_AGENDADA -> 1 pendiente de avance
    assert.deepEqual(digest.summary, {
      confirmedAmountThisWeek: 5875,
      inQuotationEstimatedAmount: 6720,
      pendingProspectsCount: 1,
    });
    assert.equal(
      digest.whatsappPayload.template.name,
      'resumen_semanal_comisiones'
    );
  });
});

describe('IngresoCerteza — Motor de KPIs de Negocio y Desglose de Estancamiento', () => {
  it('particiona el embudo sin duplicar cerrados/descartados y ordena el ranking de prospectadores', () => {
    const { dossiers, users, branches } = createDemoDataset();
    const kpis = computeDashboardKpis({ dossiers, users, branches });

    assert.equal(kpis.activeForce.activeReferrers, 3);
    assert.equal(kpis.activeForce.activeAgents, 2);
    assert.equal(kpis.prospectionVolume.totalDossiers, 5);
    assert.equal(kpis.prospectionVolume.totalOpportunities, 9);
    assert.equal(kpis.prospectionVolume.crossSellOpportunities, 2);

    const { stagnation, closedWonCount, discardedCount } = kpis.funnel;
    assert.equal(closedWonCount, 3);
    assert.equal(discardedCount, 1);
    assert.deepEqual(stagnation, {
      uncontactedCount: 1, // dos-005 AUTO (NUEVO)
      inCallCount: 1,      // dos-004 AHORRO (PRIMER_CONTACTO)
      inAppointmentCount: 1, // dos-002 PPR (CITA_AGENDADA)
      inQuotationCount: 1, // dos-001 GMM (EN_COTIZACION)
      inApplicationCount: 1, // dos-003 MASCOTAS (SOLICITUD_LLENADA)
    });

    const totalPartitioned =
      stagnation.uncontactedCount +
      stagnation.inCallCount +
      stagnation.inAppointmentCount +
      stagnation.inQuotationCount +
      stagnation.inApplicationCount +
      closedWonCount +
      discardedCount;
    assert.equal(totalPartitioned, kpis.prospectionVolume.totalOpportunities);

    // Andrés: 36,500 * 18% = 6,570.00 confirmados; Sofía: 5,875.00; Carlos: 0
    assert.equal(kpis.referrerRanking[0].referrerId, 'ref-andres');
    assert.equal(kpis.referrerRanking[0].confirmedCommissionAmount, 6570);
    assert.equal(kpis.referrerRanking[1].referrerId, 'ref-sofia');
    assert.equal(kpis.referrerRanking[1].confirmedCommissionAmount, 5875);
  });

  it('aplica filtros combinados por vendedor, prospectador y rango de fechas', () => {
    const { dossiers, users, branches } = createDemoDataset();

    const byAgent = computeDashboardKpis({
      dossiers,
      users,
      branches,
      filters: { agentId: 'agt-diego' },
    });
    assert.equal(byAgent.prospectionVolume.totalDossiers, 2);
    assert.equal(byAgent.prospectionVolume.totalOpportunities, 4);

    const byDateWindow = computeDashboardKpis({
      dossiers,
      users,
      branches,
      filters: {
        startDate: '2026-11-20',
        endDate: '2026-11-24',
        referrerId: 'ref-carlos',
      },
    });
    // Incluye venta cruzada MASCOTAS creada el 2026-11-21 en dos-003 y alta dos-005 del 2026-11-24
    assert.equal(byDateWindow.prospectionVolume.totalOpportunities, 2);
  });
});
