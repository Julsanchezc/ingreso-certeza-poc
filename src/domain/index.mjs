import {
  BRANCH_CODES,
  COMMERCIAL_STAGES,
  COMMISSION_STATUS,
  INSURANCE_BRANCHES,
  ROLES,
  STAGE_BY_CODE,
  STAGE_CODES,
  registerInsuranceBranch,
} from './constants.mjs';
import {
  calculateOpportunityCommission,
  resolveCommissionRate,
  roundCurrency,
} from './commissionEngine.mjs';
import {
  addCrossSellOpportunity,
  createProspectDossier,
  transitionDossierOpportunity,
  transitionOpportunityStage,
} from './stageMachine.mjs';
import {
  buildStageAlertPayload,
  buildWeeklyDigestPayload,
  normalizeWhatsAppPhone,
} from './whatsappNotifier.mjs';
import { computeDashboardKpis } from './kpiAnalytics.mjs';

export {
  BRANCH_CODES,
  COMMERCIAL_STAGES,
  COMMISSION_STATUS,
  INSURANCE_BRANCHES,
  ROLES,
  STAGE_BY_CODE,
  STAGE_CODES,
  registerInsuranceBranch,
  roundCurrency,
  resolveCommissionRate,
  calculateOpportunityCommission,
  createProspectDossier,
  addCrossSellOpportunity,
  transitionOpportunityStage,
  transitionDossierOpportunity,
  normalizeWhatsAppPhone,
  buildStageAlertPayload,
  buildWeeklyDigestPayload,
  computeDashboardKpis,
};

/**
 * Construye una instantánea determinista y rica del dominio mediante las propias funciones
 * de transición de negocio, garantizando que el simulador `web-demo/` arranque con bitácoras,
 * comisiones diferenciadas, venta cruzada y alertas HSM congruentes sin duplicar datos estáticos.
 */
export function createDemoDataset() {
  const branches = [...INSURANCE_BRANCHES];

  const users = [
    {
      id: 'ref-sofia',
      fullName: 'Sofía Ramírez',
      role: ROLES.PROSPECTADOR,
      phone: '+525541239876',
      email: 'sofia.ramirez@aliados.mx',
      active: true,
    },
    {
      id: 'ref-carlos',
      fullName: 'Carlos Méndez',
      role: ROLES.PROSPECTADOR,
      phone: '+523319876543',
      email: 'carlos.mendez@aliados.mx',
      active: true,
    },
    {
      id: 'ref-andres',
      fullName: 'Andrés Gómez',
      role: ROLES.PROSPECTADOR,
      phone: '+573104567890',
      email: 'andres.gomez@aliados.co',
      active: true,
    },
    {
      id: 'agt-valeria',
      fullName: 'Valeria Torres',
      role: ROLES.VENDEDOR,
      phone: '+525587654321',
      email: 'valeria.torres@ingresocerteza.mx',
      active: true,
    },
    {
      id: 'agt-diego',
      fullName: 'Diego Herrera',
      role: ROLES.VENDEDOR,
      phone: '+528112349876',
      email: 'diego.herrera@ingresocerteza.mx',
      active: true,
    },
    {
      id: 'adm-elena',
      fullName: 'Elena Ruiz',
      role: ROLES.ADMIN,
      phone: '+525599887766',
      email: 'elena.ruiz@ingresocerteza.mx',
      active: true,
    },
  ];

  const customRules = [
    {
      id: 'rule-sofia-gmm',
      referrerId: 'ref-sofia',
      branchCode: BRANCH_CODES.GASTOS_MEDICOS,
      ratePercent: 16,
      active: true,
      note: 'Convenio preferente por cartera médica ejecutiva',
    },
    {
      id: 'rule-sofia-auto',
      referrerId: 'ref-sofia',
      branchCode: BRANCH_CODES.AUTO,
      ratePercent: 12.5,
      active: true,
      note: 'Bono trimestral alianza agencias seminuevos',
    },
    {
      id: 'rule-andres-vida',
      referrerId: 'ref-andres',
      branchCode: BRANCH_CODES.VIDA,
      ratePercent: 18,
      active: true,
      note: 'Esquema senior protección patrimonial binacional',
    },
  ];

  // Expediente 1: Juan Pérez (Auto pagado + Venta Cruzada en Gastos Médicos en cotización)
  let dos1 = createProspectDossier({
    id: 'dos-001',
    fullName: 'Juan Pérez Hernández',
    phone: '+52 1 55 2345 6789',
    email: 'juan.perez@empresa.mx',
    initialBranchCodes: [BRANCH_CODES.AUTO],
    referrerId: 'ref-sofia',
    assignedAgentId: 'agt-valeria',
    notes: 'Compra camioneta nueva; solicita cotización amplia.',
    customRules,
    branches,
    createdAt: '2026-11-18T14:10:00.000Z',
  });
  dos1 = transitionDossierOpportunity(dos1, 'dos-001-opp-1', {
    nextStage: STAGE_CODES.PRIMER_CONTACTO,
    actorId: 'agt-valeria',
    actorRole: ROLES.VENDEDOR,
    notes: 'Llamada efectiva; envió tarjeta de circulación.',
    customRules,
    branches,
    transitionedAt: '2026-11-18T16:30:00.000Z',
  });
  dos1 = transitionDossierOpportunity(dos1, 'dos-001-opp-1', {
    nextStage: STAGE_CODES.EN_COTIZACION,
    actorId: 'agt-valeria',
    actorRole: ROLES.VENDEDOR,
    estimatedPremium: 18500,
    notes: 'Comparativo enviado con cobertura amplia deducible 3%.',
    customRules,
    branches,
    transitionedAt: '2026-11-19T11:00:00.000Z',
  });
  dos1 = transitionDossierOpportunity(dos1, 'dos-001-opp-1', {
    nextStage: STAGE_CODES.SOLICITUD_LLENADA,
    actorId: 'agt-valeria',
    actorRole: ROLES.VENDEDOR,
    notes: 'Expediente KYC firmado digitalmente.',
    customRules,
    branches,
    transitionedAt: '2026-11-20T09:45:00.000Z',
  });
  dos1 = transitionDossierOpportunity(dos1, 'dos-001-opp-1', {
    nextStage: STAGE_CODES.POLIZA_PAGADA,
    actorId: 'agt-valeria',
    actorRole: ROLES.VENDEDOR,
    finalPremium: 18200,
    notes: 'Cargo anual domiciliado aplicado con descuento pronto pago.',
    customRules,
    branches,
    transitionedAt: '2026-11-21T15:20:00.000Z',
  });
  dos1 = addCrossSellOpportunity(dos1, {
    branchCode: BRANCH_CODES.GASTOS_MEDICOS,
    actorId: 'agt-valeria',
    actorRole: ROLES.VENDEDOR,
    notes: 'Durante entrega de póliza de auto solicitó proteger a su familia en GMM.',
    customRules,
    branches,
    createdAt: '2026-11-21T15:35:00.000Z',
  });
  dos1 = transitionDossierOpportunity(dos1, 'dos-001-opp-2', {
    nextStage: STAGE_CODES.EN_COTIZACION,
    actorId: 'agt-valeria',
    actorRole: ROLES.VENDEDOR,
    estimatedPremium: 42000,
    notes: 'Cotización familiar hospital nivel medio con tabulador quirúrgico amplio.',
    customRules,
    branches,
    transitionedAt: '2026-11-22T12:15:00.000Z',
  });

  // Expediente 2: Mariana López (Multi-ramo inicial: Vida pagada + PPR estancado en cita)
  let dos2 = createProspectDossier({
    id: 'dos-002',
    fullName: 'Mariana López Vega',
    phone: '55 6789 4321',
    email: 'mariana.lopez@consultoria.mx',
    initialBranchCodes: [BRANCH_CODES.VIDA, BRANCH_CODES.PPR],
    referrerId: 'ref-sofia',
    assignedAgentId: 'agt-valeria',
    notes: 'Directora financiera interesada en deducibilidad fiscal art. 151 LISR.',
    customRules,
    branches,
    createdAt: '2026-11-19T09:00:00.000Z',
  });
  dos2 = transitionDossierOpportunity(dos2, 'dos-002-opp-1', {
    nextStage: STAGE_CODES.EN_COTIZACION,
    actorId: 'agt-valeria',
    actorRole: ROLES.VENDEDOR,
    estimatedPremium: 24000,
    notes: 'Suma asegurada dotal 10 años en UDIS.',
    customRules,
    branches,
    transitionedAt: '2026-11-20T13:00:00.000Z',
  });
  dos2 = transitionDossierOpportunity(dos2, 'dos-002-opp-1', {
    nextStage: STAGE_CODES.POLIZA_PAGADA,
    actorId: 'agt-valeria',
    actorRole: ROLES.VENDEDOR,
    finalPremium: 24000,
    notes: 'Emitida sin extraprima médica y primer recibo liquidado.',
    customRules,
    branches,
    transitionedAt: '2026-11-23T10:30:00.000Z',
  });
  dos2 = transitionDossierOpportunity(dos2, 'dos-002-opp-2', {
    nextStage: STAGE_CODES.CITA_AGENDADA,
    actorId: 'agt-valeria',
    actorRole: ROLES.VENDEDOR,
    notes: 'Revisión con su contador agendada para proyectar aportaciones PPR.',
    customRules,
    branches,
    transitionedAt: '2026-11-22T17:00:00.000Z',
  });

  // Expediente 3: Roberto Sánchez (Hogar descartado + Mascotas por venta cruzada en solicitud)
  let dos3 = createProspectDossier({
    id: 'dos-003',
    fullName: 'Roberto Sánchez Ruiz',
    phone: '33 2233 4455',
    email: 'roberto.sanchez@arquitectura.mx',
    initialBranchCodes: [BRANCH_CODES.HOGAR],
    referrerId: 'ref-carlos',
    assignedAgentId: 'agt-diego',
    notes: 'Departamento recién escriturado en Guadalajara.',
    customRules,
    branches,
    createdAt: '2026-11-19T15:20:00.000Z',
  });
  dos3 = transitionDossierOpportunity(dos3, 'dos-003-opp-1', {
    nextStage: STAGE_CODES.PRIMER_CONTACTO,
    actorId: 'agt-diego',
    actorRole: ROLES.VENDEDOR,
    notes: 'Contacto telefónico; revisará cláusula endosada de su crédito bancario.',
    customRules,
    branches,
    transitionedAt: '2026-11-20T10:10:00.000Z',
  });
  dos3 = transitionDossierOpportunity(dos3, 'dos-003-opp-1', {
    nextStage: STAGE_CODES.DESCARTADO,
    actorId: 'agt-diego',
    actorRole: ROLES.VENDEDOR,
    rejectionReason: 'Póliza multianual ya incluida forzosamente en su hipoteca bancaria',
    customRules,
    branches,
    transitionedAt: '2026-11-21T11:40:00.000Z',
  });
  dos3 = addCrossSellOpportunity(dos3, {
    branchCode: BRANCH_CODES.MASCOTAS,
    actorId: 'agt-diego',
    actorRole: ROLES.VENDEDOR,
    notes: 'Interesado en responsabilidad civil y gastos veterinarios para Golden Retriever.',
    customRules,
    branches,
    createdAt: '2026-11-21T11:50:00.000Z',
  });
  dos3 = transitionDossierOpportunity(dos3, 'dos-003-opp-2', {
    nextStage: STAGE_CODES.EN_COTIZACION,
    actorId: 'agt-diego',
    actorRole: ROLES.VENDEDOR,
    estimatedPremium: 6400,
    notes: 'Plan integral con cobertura de cirugía y vacunas.',
    customRules,
    branches,
    transitionedAt: '2026-11-22T09:30:00.000Z',
  });
  dos3 = transitionDossierOpportunity(dos3, 'dos-003-opp-2', {
    nextStage: STAGE_CODES.SOLICITUD_LLENADA,
    actorId: 'agt-diego',
    actorRole: ROLES.VENDEDOR,
    notes: 'Cartilla veterinaria validada; pendiente cobro con tarjeta.',
    customRules,
    branches,
    transitionedAt: '2026-11-23T16:05:00.000Z',
  });

  // Expediente 4: Camila Restrepo (Contacto E.164 Colombia: Vida pagada + Ahorro en llamada)
  let dos4 = createProspectDossier({
    id: 'dos-004',
    fullName: 'Camila Restrepo Arango',
    phone: '+57 310 456 7890',
    email: 'camila.restrepo@medellin.co',
    initialBranchCodes: [BRANCH_CODES.VIDA, BRANCH_CODES.AHORRO],
    referrerId: 'ref-andres',
    assignedAgentId: 'agt-diego',
    notes: 'Ejecutiva expatriada; busca cobertura internacional y ahorro educativo.',
    customRules,
    branches,
    createdAt: '2026-11-20T08:15:00.000Z',
  });
  dos4 = transitionDossierOpportunity(dos4, 'dos-004-opp-1', {
    nextStage: STAGE_CODES.EN_COTIZACION,
    actorId: 'agt-diego',
    actorRole: ROLES.VENDEDOR,
    estimatedPremium: 35000,
    notes: 'Cobertura fallecimiento + invalidez total.',
    customRules,
    branches,
    transitionedAt: '2026-11-21T14:00:00.000Z',
  });
  dos4 = transitionDossierOpportunity(dos4, 'dos-004-opp-1', {
    nextStage: STAGE_CODES.POLIZA_PAGADA,
    actorId: 'agt-diego',
    actorRole: ROLES.VENDEDOR,
    finalPremium: 36500,
    notes: 'Póliza pagada anual con endoso de beneficios adicionales.',
    customRules,
    branches,
    transitionedAt: '2026-11-24T11:20:00.000Z',
  });
  dos4 = transitionDossierOpportunity(dos4, 'dos-004-opp-2', {
    nextStage: STAGE_CODES.PRIMER_CONTACTO,
    actorId: 'agt-diego',
    actorRole: ROLES.VENDEDOR,
    notes: 'Llamada inicial realizada; definirá monto mensual de ahorro la próxima semana.',
    customRules,
    branches,
    transitionedAt: '2026-11-23T18:00:00.000Z',
  });

  // Expediente 5: Fernando Castillo (Recién ingresado, sin primer contacto)
  const dos5 = createProspectDossier({
    id: 'dos-005',
    fullName: 'Fernando Castillo Mora',
    phone: '81 3456 7890',
    email: 'f.castillo@logistica.mx',
    initialBranchCodes: [BRANCH_CODES.AUTO],
    referrerId: 'ref-carlos',
    assignedAgentId: 'agt-valeria',
    notes: 'Vence su póliza actual en 10 días.',
    customRules,
    branches,
    createdAt: '2026-11-24T13:45:00.000Z',
  });

  const dossiers = [dos1, dos2, dos3, dos4, dos5];

  const sampleAlerts = [
    buildStageAlertPayload({
      dossier: dos1,
      opportunity: dos1.opportunities[1],
      referrerName: 'Sofía Ramírez',
      referrerPhone: '+525541239876',
      branches,
    }),
    buildStageAlertPayload({
      dossier: dos1,
      opportunity: dos1.opportunities[0],
      referrerName: 'Sofía Ramírez',
      referrerPhone: '+525541239876',
      branches,
    }),
    buildStageAlertPayload({
      dossier: dos3,
      opportunity: dos3.opportunities[0],
      referrerName: 'Carlos Méndez',
      referrerPhone: '+523319876543',
      branches,
    }),
  ];

  const weeklyDigestSofia = buildWeeklyDigestPayload({
    referrerId: 'ref-sofia',
    referrerName: 'Sofía Ramírez',
    referrerPhone: '+525541239876',
    dossiers,
    customRules,
    branches,
    weekLabel: 'Semana 48 (18-24 Nov)',
  });

  return {
    branches,
    users,
    customRules,
    dossiers,
    sampleAlerts,
    weeklyDigestSofia,
  };
}
