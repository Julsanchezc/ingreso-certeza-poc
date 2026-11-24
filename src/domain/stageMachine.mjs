import {
  INSURANCE_BRANCHES,
  ROLES,
  STAGE_BY_CODE,
  STAGE_CODES,
} from './constants.mjs';
import {
  calculateOpportunityCommission,
  roundCurrency,
} from './commissionEngine.mjs';
import { normalizeWhatsAppPhone } from './whatsappNotifier.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STAGE_MUTATION_ROLES = new Set([ROLES.VENDEDOR, ROLES.ADMIN]);

function assertValidBranch(branchCode, branches) {
  const normalized = typeof branchCode === 'string' ? branchCode.trim().toUpperCase() : '';
  const found = branches.find((item) => item.code === normalized);
  if (!found) {
    throw new Error(`Ramo asegurador no registrado: "${branchCode}".`);
  }
  if (found.active === false) {
    throw new Error(`El ramo "${normalized}" no admite nuevas aperturas por encontrarse inactivo.`);
  }
  return normalized;
}

/**
 * Abre un expediente único de referido con soporte multi-ramo de origen (RFP 4.1).
 *
 * Invariante de atribución: `originalReferrerId` queda sellado tanto en la raíz del expediente
 * como en cada oportunidad hija mediante congelamiento de objeto (`Object.freeze`). Así se evita
 * que reasignaciones de cartera entre agentes diluyan la paternidad comercial del prospectador.
 */
export function createProspectDossier({
  id,
  fullName,
  phone,
  email = null,
  initialBranchCodes,
  referrerId,
  assignedAgentId = null,
  notes = '',
  privacyNoticeAccepted = true,
  defaultCountryCode = '52',
  customRules = [],
  branches = INSURANCE_BRANCHES,
  createdAt = new Date().toISOString(),
} = {}) {
  const cleanId = typeof id === 'string' ? id.trim() : '';
  if (!cleanId) {
    throw new Error('Todo expediente requiere un identificador `id` no vacío.');
  }

  const cleanName = typeof fullName === 'string' ? fullName.trim() : '';
  if (cleanName.length < 2) {
    throw new Error('El nombre completo del prospecto debe tener al menos 2 caracteres.');
  }

  const cleanReferrerId = typeof referrerId === 'string' ? referrerId.trim() : '';
  if (!cleanReferrerId) {
    throw new Error('Se requiere `referrerId` para fijar la atribución de origen.');
  }

  const normalizedPhone = normalizeWhatsAppPhone(phone, defaultCountryCode);

  let normalizedEmail = null;
  if (email !== undefined && email !== null && String(email).trim() !== '') {
    const candidateEmail = String(email).trim().toLowerCase();
    if (!EMAIL_RE.test(candidateEmail)) {
      throw new Error(`Correo electrónico inválido: "${email}".`);
    }
    normalizedEmail = candidateEmail;
  }

  if (!Array.isArray(initialBranchCodes) || initialBranchCodes.length === 0) {
    throw new Error('Debe seleccionar al menos un ramo asegurador inicial para el prospecto.');
  }

  const seenBranches = new Set();
  const validatedBranches = initialBranchCodes.map((rawCode) => {
    const code = assertValidBranch(rawCode, branches);
    if (seenBranches.has(code)) {
      throw new Error(`Ramo duplicado en el registro inicial del expediente: "${code}".`);
    }
    seenBranches.add(code);
    return code;
  });

  const cleanAgentId =
    typeof assignedAgentId === 'string' && assignedAgentId.trim()
      ? assignedAgentId.trim()
      : null;
  const cleanNotes = typeof notes === 'string' ? notes.trim() : '';

  const opportunities = validatedBranches.map((branchCode, idx) => {
    const commission = calculateOpportunityCommission({
      stage: STAGE_CODES.NUEVO,
      estimatedPremium: 0,
      finalPremium: 0,
      referrerId: cleanReferrerId,
      branchCode,
      customRules,
      branches,
    });

    const initialAudit = Object.freeze({
      fromStage: null,
      toStage: STAGE_CODES.NUEVO,
      actorId: cleanReferrerId,
      actorRole: ROLES.PROSPECTADOR,
      notes: cleanNotes || 'Alta inicial de prospecto referido',
      rejectionReason: null,
      timestamp: createdAt,
    });

    return Object.freeze({
      id: `${cleanId}-opp-${idx + 1}`,
      dossierId: cleanId,
      branchCode,
      originalReferrerId: cleanReferrerId,
      assignedAgentId: cleanAgentId,
      stage: STAGE_CODES.NUEVO,
      estimatedPremium: 0,
      finalPremium: 0,
      rejectionReason: null,
      isCrossSell: false,
      commission,
      createdAt,
      updatedAt: createdAt,
      closedAt: null,
      auditTrail: Object.freeze([initialAudit]),
    });
  });

  return Object.freeze({
    id: cleanId,
    fullName: cleanName,
    phone: normalizedPhone,
    email: normalizedEmail,
    originalReferrerId: cleanReferrerId,
    assignedAgentId: cleanAgentId,
    privacyNoticeAccepted: Boolean(privacyNoticeAccepted),
    createdAt,
    updatedAt: createdAt,
    opportunities: Object.freeze(opportunities),
  });
}

/**
 * Incorpora un nuevo ramo por Venta Cruzada dentro de un expediente existente (RFP 4.1).
 *
 * Precondiciones de negocio:
 * - Solo `VENDEDOR` o `ADMIN` pueden expandir el expediente tras el diagnóstico comercial.
 * - La nueva oportunidad hereda `dossier.originalReferrerId` (jamás `actorId`), garantizando
 *   que la segunda comisión remunere al prospectador que aportó la relación de confianza.
 * - Bloquea aperturas paralelas del mismo ramo mientras exista una gestión activa sin cerrar,
 *   salvo bandera explícita `allowDuplicateBranch` (ej. segundo vehículo familiar).
 */
export function addCrossSellOpportunity(
  dossier,
  {
    opportunityId,
    branchCode,
    actorId,
    actorRole,
    notes = '',
    allowDuplicateBranch = false,
    customRules = [],
    branches = INSURANCE_BRANCHES,
    createdAt = new Date().toISOString(),
  } = {}
) {
  if (!dossier || typeof dossier !== 'object' || !dossier.originalReferrerId) {
    throw new Error('Se requiere un expediente válido con `originalReferrerId` para venta cruzada.');
  }

  const cleanActorId = typeof actorId === 'string' ? actorId.trim() : '';
  if (!cleanActorId) {
    throw new Error('Se requiere `actorId` para auditar la apertura de venta cruzada.');
  }

  if (!STAGE_MUTATION_ROLES.has(actorRole)) {
    throw new Error(
      `Permiso denegado para rol "${actorRole}": la venta cruzada requiere rol VENDEDOR o ADMIN.`
    );
  }

  const normalizedBranch = assertValidBranch(branchCode, branches);

  if (!allowDuplicateBranch) {
    const hasOpenSameBranch = dossier.opportunities.some((opp) => {
      const stageMeta = STAGE_BY_CODE[opp.stage];
      return opp.branchCode === normalizedBranch && !stageMeta?.isTerminal;
    });
    if (hasOpenSameBranch) {
      throw new Error(
        `Ya existe una oportunidad activa en el ramo "${normalizedBranch}" dentro del expediente ${dossier.id}.`
      );
    }
  }

  const resolvedOppId =
    typeof opportunityId === 'string' && opportunityId.trim()
      ? opportunityId.trim()
      : `${dossier.id}-opp-${dossier.opportunities.length + 1}`;

  if (dossier.opportunities.some((opp) => opp.id === resolvedOppId)) {
    throw new Error(`El identificador de oportunidad "${resolvedOppId}" ya existe en el expediente.`);
  }

  const commission = calculateOpportunityCommission({
    stage: STAGE_CODES.NUEVO,
    estimatedPremium: 0,
    finalPremium: 0,
    referrerId: dossier.originalReferrerId,
    branchCode: normalizedBranch,
    customRules,
    branches,
  });

  const cleanNotes = typeof notes === 'string' ? notes.trim() : '';
  const auditEntry = Object.freeze({
    fromStage: null,
    toStage: STAGE_CODES.NUEVO,
    actorId: cleanActorId,
    actorRole,
    notes: cleanNotes || `Apertura por venta cruzada (${normalizedBranch})`,
    rejectionReason: null,
    timestamp: createdAt,
  });

  const newOpportunity = Object.freeze({
    id: resolvedOppId,
    dossierId: dossier.id,
    branchCode: normalizedBranch,
    originalReferrerId: dossier.originalReferrerId,
    assignedAgentId:
      actorRole === ROLES.VENDEDOR ? cleanActorId : dossier.assignedAgentId,
    stage: STAGE_CODES.NUEVO,
    estimatedPremium: 0,
    finalPremium: 0,
    rejectionReason: null,
    isCrossSell: true,
    commission,
    createdAt,
    updatedAt: createdAt,
    closedAt: null,
    auditTrail: Object.freeze([auditEntry]),
  });

  return Object.freeze({
    ...dossier,
    originalReferrerId: dossier.originalReferrerId,
    updatedAt: createdAt,
    opportunities: Object.freeze([...dossier.opportunities, newOpportunity]),
  });
}

/**
 * Ejecuta una transición controlada sobre las 7 etapas comerciales (RFP 4.2).
 *
 * Guardas deterministas:
 * - Prohibido mutar etapas desde rol `PROSPECTADOR` (perfil estrictamente observador tras el alta).
 * - Las etapas terminales (`POLIZA_PAGADA`, `DESCARTADO`) quedan bloqueadas ante `VENDEDOR`;
 *   solo `ADMIN` puede reabrirlas por aclaración operativa.
 * - `EN_COTIZACION` exige prima estimada > 0 para proyectar comisión transparente.
 * - `POLIZA_PAGADA` exige prima pagada o estimada > 0 antes de habilitar el cobro.
 * - `DESCARTADO` exige motivo explícito (>= 5 caracteres) para retroalimentar al prospectador.
 */
export function transitionOpportunityStage(
  opportunity,
  {
    nextStage,
    actorId,
    actorRole,
    estimatedPremium,
    finalPremium,
    rejectionReason,
    notes = '',
    customRules = [],
    branches = INSURANCE_BRANCHES,
    transitionedAt = new Date().toISOString(),
  } = {}
) {
  if (!opportunity || typeof opportunity !== 'object') {
    throw new Error('Se requiere una oportunidad válida para cambiar de etapa.');
  }

  const cleanActorId = typeof actorId === 'string' ? actorId.trim() : '';
  if (!cleanActorId) {
    throw new Error('Se requiere `actorId` para registrar la bitácora de transición.');
  }

  if (!STAGE_MUTATION_ROLES.has(actorRole)) {
    throw new Error(
      `Permiso denegado para rol "${actorRole}": solo VENDEDOR o ADMIN pueden actualizar etapas.`
    );
  }

  const targetStageMeta = STAGE_BY_CODE[nextStage];
  if (!targetStageMeta) {
    throw new Error(`Etapa destino desconocida: "${nextStage}".`);
  }

  const currentStageMeta = STAGE_BY_CODE[opportunity.stage];
  if (currentStageMeta?.isTerminal && actorRole !== ROLES.ADMIN) {
    throw new Error(
      `La oportunidad ${opportunity.id} ya se encuentra cerrada en "${opportunity.stage}"; solo ADMIN puede reabrirla.`
    );
  }

  const resolvedEstimated =
    estimatedPremium !== undefined && estimatedPremium !== null
      ? Number(estimatedPremium)
      : Number(opportunity.estimatedPremium ?? 0);

  if (!Number.isFinite(resolvedEstimated) || resolvedEstimated < 0) {
    throw new Error('La prima estimada debe ser un número finito mayor o igual a 0.');
  }

  if (nextStage === STAGE_CODES.EN_COTIZACION && resolvedEstimated <= 0) {
    throw new Error(
      'Avanzar a EN_COTIZACION exige registrar una prima estimada mayor a 0.'
    );
  }

  let resolvedFinal =
    finalPremium !== undefined && finalPremium !== null
      ? Number(finalPremium)
      : Number(opportunity.finalPremium ?? 0);

  if (!Number.isFinite(resolvedFinal) || resolvedFinal < 0) {
    throw new Error('La prima final debe ser un número finito mayor o igual a 0.');
  }

  if (nextStage === STAGE_CODES.POLIZA_PAGADA) {
    const payableBase =
      finalPremium !== undefined && finalPremium !== null
        ? resolvedFinal
        : resolvedEstimated;
    if (!Number.isFinite(payableBase) || payableBase <= 0) {
      throw new Error(
        'Registrar POLIZA_PAGADA exige una prima final emitida o prima estimada mayor a 0.'
      );
    }
    resolvedFinal = payableBase;
  }

  let cleanRejectionReason = null;
  if (nextStage === STAGE_CODES.DESCARTADO) {
    cleanRejectionReason =
      typeof rejectionReason === 'string' ? rejectionReason.trim() : '';
    if (cleanRejectionReason.length < 5) {
      throw new Error(
        'Descartar una oportunidad exige especificar un motivo válido de al menos 5 caracteres.'
      );
    }
  }

  const commission = calculateOpportunityCommission({
    stage: nextStage,
    estimatedPremium: resolvedEstimated,
    finalPremium: resolvedFinal,
    referrerId: opportunity.originalReferrerId,
    branchCode: opportunity.branchCode,
    customRules,
    branches,
  });

  const cleanNotes = typeof notes === 'string' ? notes.trim() : '';
  const auditEntry = Object.freeze({
    fromStage: opportunity.stage,
    toStage: nextStage,
    actorId: cleanActorId,
    actorRole,
    notes:
      nextStage === STAGE_CODES.DESCARTADO
        ? cleanNotes || `Descartado: ${cleanRejectionReason}`
        : cleanNotes || `Avance a ${targetStageMeta.label}`,
    rejectionReason: cleanRejectionReason,
    timestamp: transitionedAt,
  });

  const closedAt = targetStageMeta.isTerminal ? transitionedAt : null;

  return Object.freeze({
    ...opportunity,
    originalReferrerId: opportunity.originalReferrerId,
    stage: nextStage,
    estimatedPremium: roundCurrency(resolvedEstimated),
    finalPremium: roundCurrency(resolvedFinal),
    rejectionReason: cleanRejectionReason,
    commission,
    updatedAt: transitionedAt,
    closedAt,
    auditTrail: Object.freeze([...(opportunity.auditTrail ?? []), auditEntry]),
  });
}

/**
 * Actualiza de forma inmutable una oportunidad específica dentro del expediente contenedor.
 */
export function transitionDossierOpportunity(dossier, opportunityId, transitionParams = {}) {
  if (!dossier || !Array.isArray(dossier.opportunities)) {
    throw new Error('Expediente inválido al intentar actualizar oportunidad.');
  }

  const index = dossier.opportunities.findIndex((opp) => opp.id === opportunityId);
  if (index === -1) {
    throw new Error(`No existe la oportunidad "${opportunityId}" en el expediente ${dossier.id}.`);
  }

  const updatedOpp = transitionOpportunityStage(dossier.opportunities[index], transitionParams);
  const nextOpportunities = dossier.opportunities.map((opp, idx) =>
    idx === index ? updatedOpp : opp
  );

  return Object.freeze({
    ...dossier,
    originalReferrerId: dossier.originalReferrerId,
    updatedAt: updatedOpp.updatedAt,
    opportunities: Object.freeze(nextOpportunities),
  });
}
